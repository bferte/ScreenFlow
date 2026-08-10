import type { RecordingManifest } from './telemetry'

/** 16:9 landscape, or 9:16 for Shorts / Reels. */
export type AspectRatio = '16:9' | '9:16'

/**
 * How the source is fitted when its aspect does not match the output.
 *
 * `crop` takes a slice at the output's aspect, steered by the camera — the
 * usable option for turning a landscape capture into a Short.
 * `fit-blur` / `fit-gradient` letterbox the whole frame and dress the bars.
 */
export type FramingMode = 'crop' | 'fit-blur' | 'fit-gradient'

export interface ClipBase {
  id: string
  /** Trim inside the source media, in source time. */
  inMs: number
  outMs: number
  /** Gain applied to this clip's own audio. */
  volume: number
}

/** A screen capture, with telemetry and therefore automatic camera work. */
export interface RecordingClip extends ClipBase {
  kind: 'recording'
  manifest: RecordingManifest
}

/** An imported file: intro, jingle, outro, b-roll, or a bare audio bed. */
export interface MediaClip extends ClipBase {
  kind: 'media'
  path: string
  name: string
  /** Null for audio-only files. */
  width: number | null
  height: number | null
  hasAudio: boolean
  hasVideo: boolean
  sourceDurationMs: number
}

export type Clip = RecordingClip | MediaClip

export interface ProbedMedia {
  path: string
  name: string
  durationMs: number
  width: number | null
  height: number | null
  hasAudio: boolean
  hasVideo: boolean
}

/**
 * Everything the editor needs to render a timeline.
 *
 * Held in memory for now; nothing is written back to disk, so edits are lost
 * when the editor closes. Persisting this object is the natural next step.
 */
export interface Project {
  version: 2
  clips: Clip[]
  aspect: AspectRatio
  framing: FramingMode
}

export function clipDuration(clip: Clip): number {
  return Math.max(0, clip.outMs - clip.inMs)
}
