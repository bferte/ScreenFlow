import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  protocol,
  screen,
  shell,
} from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { mouseTracker, describeDisplay, globalHookError } from './mouse-tracker'
import { remuxInPlace, probeMedia } from './ffmpeg'
import { getPublicSettings, saveSettings, type StoredSettings } from './settings'
import { speak, voiceoverRoot, type SpeakRequest } from './tts'
import {
  cancelExport,
  disposeAllExports,
  finishExport,
  startExport,
  writeFrame,
  type ExportStartOptions,
} from './export'
import type { RecordingManifest, Telemetry } from '../src/types/telemetry'

const DIST_ELECTRON = __dirname
const DIST = path.join(DIST_ELECTRON, '../dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

let win: BrowserWindow | null = null

function recordingsRoot() {
  return path.join(app.getPath('videos'), 'ScreenFlow')
}

/**
 * Files outside the recordings directory that the streaming protocol may serve.
 *
 * Imported jingles live anywhere on disk, but opening the protocol to the whole
 * filesystem would turn any renderer bug into an arbitrary file read. A path
 * only lands here after the user picked it in the system file dialog, so the
 * grant is per-file and traceable to a deliberate action.
 */
const importedMedia = new Set<string>()

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0f1014',
    title: 'ScreenFlow',
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    // Mirror renderer logs into the terminal. Without this, anything that goes
    // wrong in the page is only visible to whoever has DevTools open.
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['LOG', 'WARN', 'ERROR', 'DEBUG'][level] ?? 'LOG'
      if (sourceId.startsWith('devtools://')) return
      console.log(`[renderer:${tag}] ${message}  (${sourceId}:${line})`)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[renderer gone]', details.reason, details.exitCode)
    })
    win.loadURL(VITE_DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(DIST, 'index.html'))
  }

  win.on('closed', () => {
    win = null
  })
}

/**
 * Recordings live outside the app bundle, and a page served from the dev
 * server may not read file:// URLs. This scheme streams them instead.
 *
 * Range support is the point: without 206 responses Chromium refuses to seek
 * and pulls the whole file before playing, which is untenable once a recording
 * runs to a gigabyte.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'screenflow',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
}

/**
 * Turns the pathname of a `screenflow://` URL back into an absolute path.
 *
 * `mediaUrl` puts the whole path in the URL's path segment, so the two
 * platforms arrive in different shapes: a POSIX path keeps its own leading
 * slash on top of the scheme's (`//Users/...`), while a Windows path comes as
 * `/C:/...`. Stripping every leading slash would leave the POSIX case
 * *relative*, so it would match neither root below and 403 on every file.
 * Only the drive-letter form gives its slash up.
 */
function pathFromUrl(pathname: string): string {
  const collapsed = decodeURIComponent(pathname).replace(/^\/+/, '/')
  return path.normalize(/^\/[A-Za-z]:/.test(collapsed) ? collapsed.slice(1) : collapsed)
}

function registerMediaProtocol() {
  protocol.handle('screenflow', async (request) => {
    const url = new URL(request.url)
    const filePath = pathFromUrl(url.pathname)

    // Recordings directory, generated voiceover, or a file the user explicitly
    // imported. normalize() has already collapsed any `..`, so none of these
    // can be walked out of.
    if (
      !filePath.startsWith(recordingsRoot()) &&
      !filePath.startsWith(voiceoverRoot()) &&
      !importedMedia.has(filePath)
    ) {
      console.warn('[protocol] refusé (hors périmètre)', { url: request.url, filePath })
      return new Response('Forbidden', { status: 403 })
    }

    let size: number
    try {
      size = (await fs.stat(filePath)).size
    } catch {
      console.warn('[protocol] introuvable', { url: request.url, filePath })
      return new Response('Not found', { status: 404 })
    }
    console.log('[protocol] sert', filePath, size, 'octets', request.headers.get('Range') ?? '')

    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('Range') ?? '')

    if (range) {
      const start = range[1] ? Number(range[1]) : 0
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start >= size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        })
      }
      const stream = Readable.toWeb(createReadStream(filePath, { start, end }))
      return new Response(stream as ReadableStream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          // Web Audio silently taints cross-origin media: createMediaElementSource
          // yields a graph that outputs nothing at all, with no error raised.
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    const stream = Readable.toWeb(createReadStream(filePath))
    return new Response(stream as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      },
    })
  })
}

app.whenReady().then(() => {
  registerMediaProtocol()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (mouseTracker.isRecording) mouseTracker.stop()
  if (process.platform !== 'darwin') app.quit()
})

/* ------------------------------------------------------------------ *
 * Capture sources
 * ------------------------------------------------------------------ */

ipcMain.handle('capture:list-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false,
  })

  // `display_id` is a string on the source but a number on the Display object.
  const displays = screen.getAllDisplays()

  return sources.map((s) => {
    const display = displays.find((d) => String(d.id) === s.display_id)
    return {
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      displayId: display ? display.id : null,
      thumbnail: s.thumbnail.toDataURL(),
    }
  })
})

ipcMain.handle('capture:primary-display', () => describeDisplay(screen.getPrimaryDisplay().id))

/* ------------------------------------------------------------------ *
 * Telemetry
 * ------------------------------------------------------------------ */

ipcMain.handle('telemetry:start', (_e, displayId: number | null) => {
  const id = displayId ?? screen.getPrimaryDisplay().id
  const result = mouseTracker.start(id)
  return { ...result, hookError: result.clicksAvailable ? null : globalHookError() }
})

ipcMain.handle('telemetry:stop', () => mouseTracker.stop())

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

interface SavePayload {
  video: ArrayBuffer
  mic: ArrayBuffer | null
  systemAudio: ArrayBuffer | null
  telemetry: Telemetry
}

ipcMain.handle('recording:save', async (_e, payload: SavePayload): Promise<RecordingManifest> => {
  const id = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(recordingsRoot(), id)
  await fs.mkdir(dir, { recursive: true })

  const videoPath = path.join(dir, 'screen.webm')
  await fs.writeFile(videoPath, Buffer.from(payload.video))

  let micPath: string | null = null
  if (payload.mic && payload.mic.byteLength > 0) {
    micPath = path.join(dir, 'mic.webm')
    await fs.writeFile(micPath, Buffer.from(payload.mic))
  }

  let systemAudioPath: string | null = null
  if (payload.systemAudio && payload.systemAudio.byteLength > 0) {
    systemAudioPath = path.join(dir, 'system.webm')
    await fs.writeFile(systemAudioPath, Buffer.from(payload.systemAudio))
  }

  const telemetryPath = path.join(dir, 'telemetry.json')
  await fs.writeFile(telemetryPath, JSON.stringify(payload.telemetry, null, 2), 'utf8')

  // Rewrite the containers so they carry a duration and cues; without this the
  // editor's <video> reports Infinity and refuses to seek.
  const remuxed = await Promise.all(
    [videoPath, micPath, systemAudioPath]
      .filter((p): p is string => p !== null)
      .map(remuxInPlace),
  )

  const manifest: RecordingManifest = {
    seekable: remuxed.every(Boolean),
    id,
    dir,
    createdAt: Date.now(),
    duration: payload.telemetry.duration,
    videoPath,
    micPath,
    systemAudioPath,
    telemetryPath,
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  return manifest
})

ipcMain.handle('recording:list', async (): Promise<RecordingManifest[]> => {
  const root = recordingsRoot()
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }

  const manifests = await Promise.all(
    entries.map(async (name) => {
      try {
        const raw = await fs.readFile(path.join(root, name, 'manifest.json'), 'utf8')
        return JSON.parse(raw) as RecordingManifest
      } catch {
        return null
      }
    }),
  )

  return manifests
    .filter((m): m is RecordingManifest => m !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
})

ipcMain.handle('recording:read-telemetry', async (_e, telemetryPath: string): Promise<Telemetry> => {
  const raw = await fs.readFile(telemetryPath, 'utf8')
  return JSON.parse(raw) as Telemetry
})

ipcMain.handle('recording:reveal', (_e, target: string) => {
  shell.showItemInFolder(target)
})

/**
 * Resolves a recording id to its directory, refusing anything outside the
 * recordings root.
 *
 * The id arrives from the renderer, and the two handlers below rename and
 * *delete* what it points at. `..` in an id must not be able to walk out —
 * normalize() collapses it, and the prefix check is what makes that binding.
 */
function recordingDir(id: string): string {
  const root = recordingsRoot()
  const dir = path.normalize(path.join(root, id))
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error('Enregistrement hors du dossier de captures')
  }
  return dir
}

/** Renames a recording. An empty name clears it, falling back to the date. */
ipcMain.handle('recording:rename', async (_e, id: string, name: string): Promise<RecordingManifest> => {
  const file = path.join(recordingDir(id), 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as RecordingManifest
  const trimmed = name.trim().slice(0, 120)
  const next: RecordingManifest = { ...manifest }
  if (trimmed) next.name = trimmed
  else delete next.name
  await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8')
  return next
})

/**
 * Deletes a recording, to the trash when the platform has one.
 *
 * A capture is minutes of work that cannot be re-shot identically, so the
 * recoverable path is tried first. Permanent removal is the fallback — some
 * Linux setups have no trash at all — and the caller is told which happened
 * rather than left to assume.
 */
ipcMain.handle('recording:delete', async (_e, id: string): Promise<{ trashed: boolean }> => {
  const dir = recordingDir(id)
  try {
    await shell.trashItem(dir)
    return { trashed: true }
  } catch {
    await fs.rm(dir, { recursive: true, force: true })
    return { trashed: false }
  }
})

/* ------------------------------------------------------------------ *
 * Media import
 * ------------------------------------------------------------------ */

ipcMain.handle('media:import', async () => {
  if (!win) return []
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Importer un média',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Médias', extensions: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'ogg'] },
      { name: 'Tous les fichiers', extensions: ['*'] },
    ],
  })
  if (canceled) return []

  const probed = await Promise.all(
    filePaths.map(async (filePath) => {
      const normalised = path.normalize(filePath)
      const info = await probeMedia(normalised)
      // Selecting it in the dialog is the authorisation to stream it later.
      importedMedia.add(normalised)
      return {
        path: normalised,
        name: path.basename(normalised),
        durationMs: info.durationMs,
        width: info.width,
        height: info.height,
        hasAudio: info.hasAudio,
        hasVideo: info.hasVideo,
      }
    }),
  )
  return probed
})

/* ------------------------------------------------------------------ *
 * Settings and text-to-speech
 * ------------------------------------------------------------------ */

ipcMain.handle('settings:get', () => getPublicSettings())

ipcMain.handle('settings:set', async (_e, patch: Partial<StoredSettings>) => {
  // Never log this object: it can carry an API key.
  await saveSettings(patch)
  return getPublicSettings()
})

ipcMain.handle('tts:speak', async (_e, req: SpeakRequest) => speak(req))

ipcMain.handle('tts:add-mp3', (_e, filePath: string) => {
  importedMedia.add(path.normalize(filePath))
})

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

ipcMain.handle('export:pick-output', async (_e, defaultName: string) => {
  if (!win) return null
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Exporter la vidéo',
    defaultPath: path.join(app.getPath('videos'), defaultName),
    filters: [{ name: 'Vidéo MP4', extensions: ['mp4'] }],
  })
  return canceled ? null : filePath
})

ipcMain.handle('export:start', (_e, opts: ExportStartOptions) => startExport(opts))
ipcMain.handle('export:frame', (_e, id: string, frame: ArrayBuffer) => writeFrame(id, frame))
ipcMain.handle('export:finish', (_e, id: string) => finishExport(id))
ipcMain.handle('export:cancel', (_e, id: string) => cancelExport(id))

app.on('before-quit', () => {
  void disposeAllExports()
})
