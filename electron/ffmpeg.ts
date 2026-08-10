import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/**
 * ffmpeg-static resolves to a path inside app.asar once packaged, where the
 * binary is not executable. electron-builder unpacks it (see `asarUnpack`),
 * so we redirect to the unpacked copy.
 */
export function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw = require('ffmpeg-static') as string
  return raw.replace('app.asar', 'app.asar.unpacked')
}

export async function runFfmpeg(args: string[]): Promise<string> {
  const { stderr } = await execFileAsync(ffmpegPath(), ['-hide_banner', '-y', ...args], {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return stderr
}

export interface MediaInfo {
  durationMs: number
  width: number | null
  height: number | null
  hasAudio: boolean
  hasVideo: boolean
}

/**
 * Reads stream properties out of ffmpeg's own report.
 *
 * ffmpeg-static ships no ffprobe, so this parses `ffmpeg -i`. That command
 * always exits non-zero because no output file was given, which means the
 * information has to be recovered from the rejection rather than from a
 * successful run.
 */
export async function probeMedia(file: string): Promise<MediaInfo> {
  let output: string
  try {
    output = await runFfmpeg(['-i', file])
  } catch (e) {
    const err = e as { stderr?: string }
    if (!err.stderr) throw e
    output = err.stderr
  }

  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output)
  const durationMs = duration
    ? (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000
    : 0

  const videoLine = /Stream #\d+:\d+.*: Video: .*/.exec(output)?.[0] ?? null
  // Match the frame size only, not bitrates or the SAR/DAR pairs beside it.
  const size = videoLine ? /,\s(\d{2,5})x(\d{2,5})[\s,]/.exec(videoLine + ' ') : null

  return {
    durationMs,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    hasVideo: videoLine !== null,
    hasAudio: /Stream #\d+:\d+.*: Audio: /.test(output),
  }
}

/**
 * MediaRecorder writes a live WebM stream: the Segment header carries no
 * duration and no cues, so `video.duration` is Infinity and seeking silently
 * fails. Remuxing rewrites the container with both, at copy speed.
 *
 * Returns true when the file was replaced, false when ffmpeg refused (in which
 * case the original is left untouched and still plays front-to-back).
 */
export async function remuxInPlace(file: string): Promise<boolean> {
  const parsed = path.parse(file)
  const tmp = path.join(parsed.dir, `${parsed.name}.remux${parsed.ext}`)

  try {
    await runFfmpeg(['-i', file, '-c', 'copy', tmp])
    await fs.rename(tmp, file)
    return true
  } catch {
    await fs.rm(tmp, { force: true })
    return false
  }
}
