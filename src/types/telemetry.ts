/**
 * Telemetry captured by the Electron main process during a recording.
 *
 * All coordinates are stored twice:
 *  - `x` / `y`  : raw global screen coordinates in DIPs (what Electron reports)
 *  - `nx` / `ny`: normalised 0..1 within the captured display's bounds
 *
 * The editor only ever uses the normalised pair, so the same telemetry file
 * replays correctly regardless of the resolution the video was encoded at.
 */

export type MouseButton = 'left' | 'right' | 'middle'

export interface CursorSample {
  /** Milliseconds since recording start. */
  t: number
  x: number
  y: number
  nx: number
  ny: number
}

export interface ClickEvent {
  t: number
  x: number
  y: number
  nx: number
  ny: number
  button: MouseButton
  /** True while the button is held; a click produces a down and an up. */
  pressed: boolean
}

export interface DisplayInfo {
  id: number
  /** Bounds in DIPs. */
  x: number
  y: number
  width: number
  height: number
  scaleFactor: number
  /** Physical pixel size = bounds * scaleFactor. Matches the captured video. */
  pixelWidth: number
  pixelHeight: number
}

export interface Telemetry {
  version: 1
  /** Unix ms at which capture began; the zero point for every `t`. */
  startedAt: number
  /** Total recording length in ms. */
  duration: number
  /** Sampling rate actually used for cursor positions. */
  sampleHz: number
  display: DisplayInfo
  cursor: CursorSample[]
  clicks: ClickEvent[]
  /**
   * False when the global hook could not be loaded (e.g. the native module
   * failed to build). Cursor positions are still captured; clicks are not.
   */
  clicksAvailable: boolean
}

export interface RecordingManifest {
  /**
   * False when the post-capture remux failed, meaning the WebM still lacks
   * duration/cues and the editor must fall back to the telemetry duration.
   */
  seekable: boolean
  id: string
  /** User-given title. Absent on recordings never renamed; the date stands in. */
  name?: string
  dir: string
  createdAt: number
  duration: number
  videoPath: string
  micPath: string | null
  systemAudioPath: string | null
  telemetryPath: string
}
