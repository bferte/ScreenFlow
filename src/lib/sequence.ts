import { clipDuration, type Clip } from '@/types/project'

export interface PlacedClip {
  clip: Clip
  index: number
  /** Timeline coordinates, in ms from the start of the sequence. */
  startT: number
  endT: number
}

export interface Resolved {
  placed: PlacedClip
  /** Time inside the clip's *source* media, i.e. including its `inMs` trim. */
  localMs: number
}

/**
 * Maps timeline time onto the clip playing at that instant.
 *
 * This is the multi-clip equivalent of invariant 1: `resolve` is a pure
 * function of `t` with no playback state, so seeking, playing forward and
 * rendering offline all agree on which frame belongs where.
 */
export class Sequence {
  readonly placed: PlacedClip[]
  readonly durationMs: number

  constructor(clips: Clip[]) {
    let cursor = 0
    this.placed = clips.map((clip, index) => {
      const startT = cursor
      cursor += clipDuration(clip)
      return { clip, index, startT, endT: cursor }
    })
    this.durationMs = cursor
  }

  /**
   * Clips are contiguous and sorted, so this binary-searches. The draw loop
   * calls it every frame, and a linear scan would grow with the timeline.
   */
  resolve(tMs: number): Resolved | null {
    if (this.placed.length === 0) return null

    const t = Math.max(0, Math.min(tMs, this.durationMs))
    let lo = 0
    let hi = this.placed.length - 1

    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (t < this.placed[mid].endT) hi = mid
      else lo = mid + 1
    }

    const placed = this.placed[lo]
    // Half-open intervals everywhere except the very end, so the final frame
    // resolves to the last clip rather than falling off the sequence.
    const offset = Math.min(t - placed.startT, Math.max(0, placed.endT - placed.startT))
    return { placed, localMs: placed.clip.inMs + offset }
  }

  find(clipId: string): PlacedClip | null {
    return this.placed.find((p) => p.clip.id === clipId) ?? null
  }
}
