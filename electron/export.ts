import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ffmpegPath } from './ffmpeg'

export interface ExportStartOptions {
  outputPath: string
  width: number
  height: number
  fps: number
  crf: number
  preset: string
  /** Pre-mixed audio, already ducked. Null when the recording has no audio. */
  wav: ArrayBuffer | null
}

interface Session {
  id: string
  proc: ChildProcessWithoutNullStreams
  outputPath: string
  audioPath: string | null
  stderr: string[]
  framesWritten: number
  failed: Error | null
  /** Set once ffmpeg is gone, so a later await never waits on a dead process. */
  exit: { code: number | null } | null
}

const sessions = new Map<string, Session>()

/** Keeps only the tail of ffmpeg's chatter, which is where failures explain themselves. */
const MAX_STDERR_LINES = 60

export async function startExport(opts: ExportStartOptions): Promise<string> {
  const id = randomUUID()

  let audioPath: string | null = null
  if (opts.wav && opts.wav.byteLength > 0) {
    audioPath = path.join(os.tmpdir(), `screenflow-${id}.wav`)
    await fs.writeFile(audioPath, Buffer.from(opts.wav))
  }

  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true })

  const args = [
    '-hide_banner',
    '-y',
    // Input options must precede their -i.
    '-f', 'image2pipe',
    '-vcodec', 'png',
    '-framerate', String(opts.fps),
    '-i', 'pipe:0',
  ]

  if (audioPath) args.push('-i', audioPath, '-map', '0:v', '-map', '1:a')

  args.push(
    '-c:v', 'libx264',
    '-preset', opts.preset,
    '-crf', String(opts.crf),
    // Required for the file to play in browsers and QuickTime.
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  )

  if (audioPath) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
  }

  args.push(opts.outputPath)

  const proc = spawn(ffmpegPath(), args, { windowsHide: true })

  const session: Session = {
    id,
    proc,
    outputPath: opts.outputPath,
    audioPath,
    stderr: [],
    framesWritten: 0,
    failed: null,
    exit: null,
  }

  proc.stderr.on('data', (chunk: Buffer) => {
    session.stderr.push(chunk.toString())
    if (session.stderr.length > MAX_STDERR_LINES) session.stderr.shift()
  })

  proc.on('close', (code) => {
    session.exit = { code }
  })

  // A dead pipe would otherwise surface as an unhandled EPIPE and take the
  // whole main process down mid-export.
  proc.stdin.on('error', (err: Error) => {
    session.failed = err
  })
  proc.on('error', (err: Error) => {
    session.failed = err
  })

  sessions.set(id, session)
  return id
}

/** ffmpeg's own account of why it stopped, which is the only useful one. */
function exitError(session: Session): Error {
  const tail = session.stderr.join('').trim().slice(-2000)
  return new Error(
    `ffmpeg s'est arrêté pendant l'export (code ${session.exit?.code ?? '?'})` +
      (tail ? `\n${tail}` : ''),
  )
}

/**
 * Waits for the pipe to drain, or for ffmpeg to die — whichever comes first.
 *
 * Awaiting `drain` alone deadlocks the moment ffmpeg is gone: the event can
 * never fire again, the renderer's `await` never settles, and the export hangs
 * with a progress bar frozen mid-count and a Cancel button that cancels
 * nothing, because the loop checking that flag is itself blocked here.
 */
function drainOrExit(session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      session.proc.stdin.off('drain', onDrain)
      session.proc.off('close', onClose)
      session.proc.off('error', onError)
      session.proc.stdin.off('error', onError)
    }
    const onDrain = () => {
      stop()
      resolve()
    }
    const onClose = () => {
      stop()
      reject(exitError(session))
    }
    const onError = (err: Error) => {
      stop()
      reject(err)
    }

    session.proc.stdin.on('drain', onDrain)
    session.proc.on('close', onClose)
    session.proc.on('error', onError)
    session.proc.stdin.on('error', onError)
  })
}

export async function writeFrame(id: string, frame: ArrayBuffer): Promise<void> {
  const session = sessions.get(id)
  if (!session) throw new Error('Session d’export inconnue')
  if (session.failed) throw session.failed
  if (session.exit) throw exitError(session)

  const buf = Buffer.from(frame)
  // Respect backpressure: PNG frames arrive far faster than libx264 consumes
  // them, and ignoring the return value would grow an unbounded memory queue.
  if (!session.proc.stdin.write(buf)) {
    await drainOrExit(session)
  }
  session.framesWritten++
}

export async function finishExport(id: string): Promise<string> {
  const session = sessions.get(id)
  if (!session) throw new Error('Session d’export inconnue')

  try {
    if (session.failed) throw session.failed
    if (session.framesWritten === 0) throw new Error('Aucune image envoyée à l’encodeur')

    session.proc.stdin.end()
    // Already gone? `once` would wait for an event that has been and gone.
    const code = session.exit
      ? session.exit.code
      : ((await once(session.proc, 'close')) as [number])[0]

    if (code !== 0) {
      throw new Error(
        `ffmpeg a échoué (code ${code})\n${session.stderr.join('').slice(-2000)}`,
      )
    }
    return session.outputPath
  } finally {
    await cleanup(session)
  }
}

export async function cancelExport(id: string): Promise<void> {
  const session = sessions.get(id)
  if (!session) return
  session.proc.kill('SIGKILL')
  await cleanup(session)
  await fs.rm(session.outputPath, { force: true })
}

async function cleanup(session: Session) {
  sessions.delete(session.id)
  if (session.audioPath) await fs.rm(session.audioPath, { force: true })
}

/** Kills anything still running, e.g. when the window closes mid-export. */
export async function disposeAllExports() {
  for (const session of [...sessions.values()]) {
    session.proc.kill('SIGKILL')
    await cleanup(session)
  }
}
