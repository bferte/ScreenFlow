import type { AudioOptions } from './audio-engine'
import { renderClickBuffer } from './click-sound'
import { DuckingEnvelope } from './ducking'
import { collectSpeechSources } from './speech-sources'
import { audioBufferToWav } from './wav'
import { Sequence } from './sequence'
import type { SequenceRenderer } from './renderer'
import type { MediaPool } from './media-pool'
import { clipDuration, type AspectRatio, type Clip } from '@/types/project'
import type { VoiceoverBlock } from '@/types/voiceover'

export interface ExportOptions {
  fps: number
  /** Output height in pixels; width follows the chosen aspect ratio. */
  height: number
  /** libx264 quality, lower is better. 18 is visually lossless. */
  crf: number
  preset: string
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  fps: 30,
  height: 1080,
  crf: 18,
  preset: 'medium',
}

export interface ExportProgress {
  phase: 'audio' | 'video' | 'encoding' | 'done'
  ratio: number
  frame?: number
  totalFrames?: number
  /** Non-fatal problems, e.g. a jingle whose audio could not be decoded. */
  warnings?: string[]
}

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */

async function decode(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url)
  return ctx.decodeAudioData(await response.arrayBuffer())
}

/** Schedules one buffer at a timeline offset, trimmed and gained. */
function schedule(
  ctx: OfflineAudioContext,
  buffer: AudioBuffer,
  startT: number,
  inMs: number,
  durationMs: number,
  gain: GainNode,
) {
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(gain)
  // start(when, offset, duration) is what makes clip trimming work without
  // slicing buffers by hand.
  src.start(startT / 1000, inMs / 1000, durationMs / 1000)
}

/**
 * Renders the whole timeline's audio offline.
 *
 * Every track lands here — a recording's mic and system pair, each imported
 * clip's own soundtrack — positioned at its timeline offset. The ducking curve
 * is the *same* DuckingEnvelope the preview used, replayed as gain automation,
 * so the exported mix matches what was auditioned by construction.
 */
/** Applies a ducking curve to a gain node as scheduled automation. */
function automateDucking(gain: GainNode, envelope: DuckingEnvelope, base: number) {
  const hz = envelope.hz
  const curve = envelope.toArray()
  gain.gain.setValueAtTime(base * curve[0], 0)
  // Linear ramps between the curve's own samples; stepping would produce
  // zipper noise at 100 Hz.
  for (let i = 1; i < curve.length; i++) {
    gain.gain.linearRampToValueAtTime(base * curve[i], i / hz)
  }
}

export async function renderAudioMix(
  clips: Clip[],
  blocks: VoiceoverBlock[],
  opts: AudioOptions,
  durationMs: number,
  clickTimesMs: number[] = [],
): Promise<{ wav: ArrayBuffer | null; warnings: string[] }> {
  const warnings: string[] = []
  if (durationMs <= 0) return { wav: null, warnings }

  const sampleRate = 48000
  const offline = new OfflineAudioContext(2, Math.ceil((durationMs / 1000) * sampleRate), sampleRate)
  const sequence = new Sequence(clips)
  let anyAudio = false

  // The exported mix must duck exactly like the preview did, so the curve is
  // rebuilt from the same sources with the same code rather than approximated.
  let envelope: DuckingEnvelope | null = null
  if (opts.ducking) {
    const collected = await collectSpeechSources(offline, clips, blocks)
    warnings.push(...collected.warnings)
    envelope = DuckingEnvelope.fromSources(collected.sources, durationMs, opts)
  }

  /** Speech is never ducked; everything else is. */
  const makeGain = (base: number, ducked: boolean) => {
    const gain = offline.createGain()
    gain.connect(offline.destination)
    if (ducked && envelope) automateDucking(gain, envelope, base)
    else gain.gain.value = base
    return gain
  }

  for (const placed of sequence.placed) {
    const { clip, startT } = placed
    const length = clipDuration(clip)

    if (clip.kind === 'recording') {
      if (clip.manifest.micPath) {
        try {
          const buffer = await decode(offline, window.screenflow.mediaUrl(clip.manifest.micPath))
          schedule(offline, buffer, startT, clip.inMs, length,
            makeGain(opts.micVolume * clip.volume, false))
          anyAudio = true
        } catch {
          warnings.push('Piste micro illisible, ignorée.')
        }
      }
      if (clip.manifest.systemAudioPath) {
        try {
          const buffer = await decode(
            offline,
            window.screenflow.mediaUrl(clip.manifest.systemAudioPath),
          )
          schedule(offline, buffer, startT, clip.inMs, length,
            makeGain(opts.systemVolume * clip.volume, true))
          anyAudio = true
        } catch {
          warnings.push('Piste son système illisible, ignorée.')
        }
      }
      continue
    }

    if (!clip.hasAudio) continue
    try {
      const buffer = await decode(offline, window.screenflow.mediaUrl(clip.path))
      schedule(offline, buffer, startT, clip.inMs, length, makeGain(clip.volume, true))
      anyAudio = true
    } catch {
      warnings.push(`Audio de « ${clip.name} » non décodable, clip muet à l'export.`)
    }
  }

  for (const block of blocks) {
    try {
      const buffer = await decode(offline, window.screenflow.mediaUrl(block.audioPath))
      schedule(offline, buffer, block.timelineOffsetMs, 0, block.durationMs,
        makeGain(opts.voiceVolume * block.volume, false))
      anyAudio = true
    } catch {
      warnings.push(`Voix-off « ${block.text.slice(0, 24)}… » non décodable.`)
    }
  }

  // Clicks come last because they are the only track with no source file: the
  // same synthesis the preview used, scheduled at the same instants, ducked
  // like system audio so they never fight a voiceover.
  if (opts.clickSound && clickTimesMs.length > 0) {
    const click = renderClickBuffer(offline, opts.clickSoundId)
    const gain = makeGain(opts.clickVolume, true)
    for (const t of clickTimesMs) {
      if (t < 0 || t >= durationMs) continue
      const source = offline.createBufferSource()
      source.buffer = click
      source.connect(gain)
      source.start(t / 1000)
    }
    anyAudio = true
  }

  if (!anyAudio) return { wav: null, warnings }
  return { wav: audioBufferToWav(await offline.startRendering()), warnings }
}

/* ------------------------------------------------------------------ *
 * Video
 * ------------------------------------------------------------------ */

export interface ExportRequest {
  clips: Clip[]
  blocks: VoiceoverBlock[]
  renderer: SequenceRenderer
  pool: MediaPool
  audioOpts: AudioOptions
  exportOpts: ExportOptions
  aspect: AspectRatio
  durationMs: number
  /** Timeline instants of the recorded clicks, for the synthesised click track. */
  clickTimesMs: number[]
  outputPath: string
  onProgress: (p: ExportProgress) => void
  signal: { cancelled: boolean }
}

/**
 * Renders every output frame through the shared SequenceRenderer and streams it
 * to ffmpeg as PNG.
 *
 * PNG rather than raw RGBA because raw frames would push gigabytes through IPC;
 * PNG rather than JPEG because screen recordings are mostly text, exactly where
 * chroma subsampling shows. UI content compresses well losslessly.
 */
export async function runExport(req: ExportRequest): Promise<string> {
  const { clips, blocks, renderer, pool, audioOpts, exportOpts, durationMs, onProgress, signal } =
    req

  onProgress({ phase: 'audio', ratio: 0 })
  const { wav, warnings } = await renderAudioMix(
    clips,
    blocks,
    audioOpts,
    durationMs,
    req.clickTimesMs,
  )
  onProgress({ phase: 'audio', ratio: 1, warnings })

  const ratio = req.aspect === '9:16' ? 9 / 16 : 16 / 9
  const outHeight = Math.round(exportOpts.height / 2) * 2
  const outWidth = Math.round((outHeight * ratio) / 2) * 2

  const canvas = document.createElement('canvas')
  canvas.width = outWidth
  canvas.height = outHeight
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Contexte 2D indisponible')
  ctx.imageSmoothingQuality = 'high'

  const totalFrames = Math.max(1, Math.floor((durationMs / 1000) * exportOpts.fps))
  const sequence = renderer.sequence

  const exportId = await window.screenflow.exportStart({
    outputPath: req.outputPath,
    width: outWidth,
    height: outHeight,
    fps: exportOpts.fps,
    crf: exportOpts.crf,
    preset: exportOpts.preset,
    wav,
  })

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal.cancelled) {
        await window.screenflow.exportCancel(exportId)
        throw new Error('Export annulé')
      }

      // The centre of the output frame's interval, not its leading edge.
      //
      // An output frame covers [i/fps, (i+1)/fps), and asking for its leading
      // edge asks for a time that falls exactly on a source frame boundary —
      // where the decoder may just as well hand back the frame that *ends*
      // there. Measured on a 30 fps clip exported at 30 fps: 40 of 120 frames
      // came back identical to the previous one, i.e. a third of the source
      // dropped. Sampling the middle of the interval is unambiguous and takes
      // that to 2. A screen recording hides it — most of the frame is static —
      // but an intro is full-frame motion, so it judders visibly.
      const tMs = ((i + 0.5) / exportOpts.fps) * 1000
      const resolved = sequence.resolve(tMs)

      // Seek only the clip that is on screen. Frames falling on an audio-only
      // clip need no decode at all — the renderer fills them itself.
      if (resolved) {
        const runtime = renderer.runtimes.get(resolved.placed.clip.id)
        if (runtime?.hasVideo) {
          await pool.seekExact(resolved.placed.clip.id, resolved.localMs)
        }
      }

      renderer.render(ctx, tMs, outWidth, outHeight, (id) => pool.get(id))

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error(`Encodage PNG échoué à l'image ${i}`)

      await window.screenflow.exportFrame(exportId, await blob.arrayBuffer())
      onProgress({
        phase: 'video',
        ratio: (i + 1) / totalFrames,
        frame: i + 1,
        totalFrames,
        warnings,
      })
    }

    onProgress({ phase: 'encoding', ratio: 0, warnings })
    const result = await window.screenflow.exportFinish(exportId)
    onProgress({ phase: 'done', ratio: 1, warnings })
    return result
  } catch (e) {
    await window.screenflow.exportCancel(exportId).catch(() => undefined)
    throw e
  }
}
