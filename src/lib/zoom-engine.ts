import type { ClickEvent, CursorSample, Telemetry } from '@/types/telemetry'
import { cropExtents } from './compositor'
import { sampleCursor } from './overlays'

/**
 * A window of time during which the camera targets a point at a given zoom.
 * The spring pass turns these hard targets into smooth motion, so a segment
 * only needs to say *what* to look at, never *how* to get there.
 */
export interface ZoomSegment {
  id: string
  /** ms — the camera begins moving toward the target here. */
  startT: number
  /** ms — the camera releases back to 1x here. */
  endT: number
  /** Normalised 0..1 focus point. */
  nx: number
  ny: number
  scale: number
  /** False once the user has edited or hand-placed it. */
  auto: boolean
  /** Clicks that produced this segment, for timeline rendering. */
  clickCount: number
}

export interface ZoomOptions {
  /** Magnification at full zoom. */
  scale: number
  /** Start moving this long before the click lands, so the zoom leads the action. */
  leadMs: number
  /** Stay zoomed this long after the cluster's last click. */
  holdMs: number
  /** Clicks farther apart than this in time start a new segment. */
  clusterGapMs: number
  /** Clicks farther apart than this in normalised distance start a new segment. */
  clusterRadius: number
  /** Spring frequency in Hz. Higher snaps faster. */
  frequency: number
  /** Damping ratio. 1 = critical (no overshoot), <1 overshoots slightly. */
  damping: number
  /**
   * Two segments separated by less than this stay zoomed in between, panning
   * across instead of bouncing out to 1x and back.
   */
  bridgeMs: number
  /**
   * ...but only when their focus points are this close. Gliding at full zoom
   * across half the screen is disorienting; there, pulling out to re-establish
   * context is the better shot.
   */
  bridgeMaxDistance: number
  /**
   * Keep holding the zoom for as long as the cursor stays put, up to this long
   * after the last click. 0 disables it.
   *
   * Clicking a field and typing into it is one action, but only its first half
   * is a click: the hold would expire mid-sentence and pull the camera out of
   * the very field being filled in. A motionless cursor is the signal that
   * attention has not moved — the keyboard is in use, or the screen is being
   * read — and it costs no extra capture, since the trajectory is already
   * recorded.
   */
  dwellMaxMs: number
  /** How far the cursor may drift, normalised, before the dwell is over. */
  dwellRadius: number
}

export const DEFAULT_ZOOM_OPTIONS: ZoomOptions = {
  scale: 2,
  leadMs: 380,
  holdMs: 900,
  clusterGapMs: 1400,
  clusterRadius: 0.18,
  frequency: 1.15,
  damping: 1,
  bridgeMs: 700,
  bridgeMaxDistance: 0.35,
  dwellMaxMs: 6000,
  dwellRadius: 0.05,
}

export interface ZoomFrame {
  scale: number
  cx: number
  cy: number
}

/** Sampling rate of the precomputed spring trajectory. */
const TRACK_HZ = 120

/* ------------------------------------------------------------------ *
 * Segment generation
 * ------------------------------------------------------------------ */

function distance(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(ax - bx, ay - by)
}

/**
 * Groups clicks into clusters, then turns each cluster into one segment.
 * Two clicks belong together when they are close in *both* time and space —
 * a double-click on one button is one zoom, but clicking opposite corners a
 * second apart is two.
 */
/**
 * How long after `fromT` the cursor stays within `radius` of a point.
 *
 * Returns 0 as soon as it has already left, so a click followed by a move away
 * behaves exactly as it did before dwell existed.
 */
function dwellAfter(
  cursor: CursorSample[],
  fromT: number,
  nx: number,
  ny: number,
  radius: number,
  maxMs: number,
): number {
  if (cursor.length === 0 || maxMs <= 0) return 0
  let dwell = 0
  for (const sample of cursor) {
    if (sample.t < fromT) continue
    if (sample.t - fromT > maxMs) break
    if (distance(sample.nx, sample.ny, nx, ny) > radius) break
    dwell = sample.t - fromT
  }
  return dwell
}

export function generateSegments(
  clicks: ClickEvent[],
  opts: ZoomOptions = DEFAULT_ZOOM_OPTIONS,
  cursor: CursorSample[] = [],
): ZoomSegment[] {
  const downs = clicks.filter((c) => c.pressed).sort((a, b) => a.t - b.t)
  if (downs.length === 0) return []

  const clusters: ClickEvent[][] = []
  for (const click of downs) {
    const current = clusters[clusters.length - 1]
    if (current) {
      const last = current[current.length - 1]
      const centroidX = current.reduce((s, c) => s + c.nx, 0) / current.length
      const centroidY = current.reduce((s, c) => s + c.ny, 0) / current.length
      const near = distance(click.nx, click.ny, centroidX, centroidY) <= opts.clusterRadius
      if (click.t - last.t <= opts.clusterGapMs && near) {
        current.push(click)
        continue
      }
    }
    clusters.push([click])
  }

  const segments = clusters.map((cluster, i): ZoomSegment => {
    const first = cluster[0]
    const last = cluster[cluster.length - 1]
    const nx = cluster.reduce((s, c) => s + c.nx, 0) / cluster.length
    const ny = cluster.reduce((s, c) => s + c.ny, 0) / cluster.length
    // The hold starts counting from the moment attention leaves, not from the
    // click: typing into the field just clicked must not run the zoom out.
    const dwell = dwellAfter(cursor, last.t, nx, ny, opts.dwellRadius, opts.dwellMaxMs)
    return {
      id: `auto-${i}`,
      startT: Math.max(0, first.t - opts.leadMs),
      endT: last.t + dwell + opts.holdMs,
      nx,
      ny,
      scale: opts.scale,
      auto: true,
      clickCount: cluster.length,
    }
  })

  return resolveGaps(segments, opts)
}

/**
 * Reconciles neighbouring segments, in two ways.
 *
 * Overlapping segments would make the camera fight itself, so they fuse into
 * one focused on their click-weighted midpoint.
 *
 * Segments merely *close* together stay separate — the camera should glide
 * from one focus to the other — but the gap between them is closed so the
 * target never falls back to 1x. Without this the spring pulls toward zoomed
 * out for a fraction of a second and visibly pumps. The gap is only closed
 * when the two foci are near each other; across a long distance the pull-out
 * reads as a deliberate re-establishing shot rather than a glitch.
 */
function resolveGaps(segments: ZoomSegment[], opts: ZoomOptions): ZoomSegment[] {
  if (segments.length === 0) return []
  const out: ZoomSegment[] = [segments[0]]

  for (let i = 1; i < segments.length; i++) {
    const prev = out[out.length - 1]
    const next = segments[i]

    if (next.startT <= prev.endT) {
      const total = prev.clickCount + next.clickCount
      out[out.length - 1] = {
        ...prev,
        endT: Math.max(prev.endT, next.endT),
        nx: (prev.nx * prev.clickCount + next.nx * next.clickCount) / total,
        ny: (prev.ny * prev.clickCount + next.ny * next.clickCount) / total,
        scale: Math.max(prev.scale, next.scale),
        clickCount: total,
      }
      continue
    }

    const gap = next.startT - prev.endT
    const travel = distance(prev.nx, prev.ny, next.nx, next.ny)
    if (gap <= opts.bridgeMs && travel <= opts.bridgeMaxDistance) {
      out[out.length - 1] = { ...prev, endT: next.startT }
    }
    out.push(next)
  }

  // Renumber so ids stay contiguous after merges.
  return out.map((s, i) => (s.auto ? { ...s, id: `auto-${i}` } : s))
}

/* ------------------------------------------------------------------ *
 * Hand editing
 * ------------------------------------------------------------------ */

/** Shortest segment worth having: below this the spring never reaches its target. */
export const MIN_SEGMENT_MS = 250

/**
 * Moves a segment's bounds, keeping it valid and marking it hand-edited.
 *
 * Segments may overlap once a hand touches them — `targetAt` resolves that by
 * taking the last match, so an edit can never produce a hole in the trajectory.
 * Order in the array is therefore what decides a tie, and callers keep it
 * sorted by start.
 */
export function reshapeSegment(
  segment: ZoomSegment,
  startT: number,
  endT: number,
  durationMs: number,
): ZoomSegment {
  const start = Math.min(Math.max(0, startT), Math.max(0, durationMs - MIN_SEGMENT_MS))
  const end = Math.min(Math.max(start + MIN_SEGMENT_MS, endT), durationMs)
  return { ...segment, startT: start, endT: end, auto: false }
}

/** A segment placed by hand, with no click behind it. */
export function createSegment(
  id: string,
  startT: number,
  endT: number,
  nx: number,
  ny: number,
  opts: ZoomOptions = DEFAULT_ZOOM_OPTIONS,
): ZoomSegment {
  return {
    id,
    startT,
    endT,
    nx,
    ny,
    scale: opts.scale,
    auto: false,
    clickCount: 0,
  }
}

/* ------------------------------------------------------------------ *
 * Spring trajectory
 * ------------------------------------------------------------------ */

/**
 * Keeps the visible rectangle inside the frame.
 *
 * The travel margins are asymmetric as soon as the output aspect differs from
 * the source's: a 9:16 crop out of a 16:9 capture can slide almost the full
 * width but has no vertical room at all. The extents therefore come from the
 * compositor, which is the only place that knows both aspects.
 */
export function clampCenter(cx: number, cy: number, halfW: number, halfH: number) {
  const clamp = (v: number, half: number) =>
    half >= 0.5 ? 0.5 : Math.min(1 - half, Math.max(half, v))
  return { cx: clamp(cx, halfW), cy: clamp(cy, halfH) }
}

/**
 * A precomputed camera path.
 *
 * Springs are stateful: integrating them live would make the frame shown at
 * time t depend on how the playhead got there, so scrubbing backwards and
 * exporting would both diverge from normal playback. Integrating once up front
 * makes `sample(t)` a pure lookup — identical during playback, seeking, and
 * offline export.
 */
export interface TrackFraming {
  sourceAspect: number
  outAspect: number
  /**
   * Keep the camera on the cursor even when no click is driving a zoom.
   *
   * Pointless in 16:9, where the untouched frame already shows everything, but
   * essential in 9:16: a vertical slice of a landscape capture only covers a
   * third of its width, so a static centre would spend most of the video
   * looking at the wrong place.
   */
  followCursor: boolean
}

export const DEFAULT_FRAMING: TrackFraming = {
  sourceAspect: 16 / 9,
  outAspect: 16 / 9,
  followCursor: false,
}

export class ZoomTrack {
  private scales: Float32Array
  private xs: Float32Array
  private ys: Float32Array
  private readonly dt = 1 / TRACK_HZ

  constructor(
    readonly durationMs: number,
    readonly segments: ZoomSegment[],
    readonly opts: ZoomOptions = DEFAULT_ZOOM_OPTIONS,
    readonly framing: TrackFraming = DEFAULT_FRAMING,
    /** Required when `framing.followCursor` is set. */
    private readonly cursor: CursorSample[] = [],
  ) {
    const steps = Math.max(1, Math.ceil((durationMs / 1000) * TRACK_HZ) + 1)
    this.scales = new Float32Array(steps)
    this.xs = new Float32Array(steps)
    this.ys = new Float32Array(steps)
    this.integrate(steps)
  }

  private targetAt(tMs: number): ZoomFrame {
    // Later segments win, which matches how merging leaves them disjoint.
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i]
      if (tMs >= s.startT && tMs <= s.endT) {
        return { scale: s.scale, cx: s.nx, cy: s.ny }
      }
    }

    if (this.framing.followCursor && this.cursor.length > 0) {
      const p = sampleCursor(this.cursor, tMs)
      // The spring does the smoothing: feeding it the raw cursor is fine and
      // keeps auto-framing on exactly the same code path as click zooms.
      if (p) return { scale: 1, cx: p.nx, cy: p.ny }
    }

    return { scale: 1, cx: 0.5, cy: 0.5 }
  }

  private integrate(steps: number) {
    const omega = 2 * Math.PI * this.opts.frequency
    const k = omega * omega
    const c = 2 * this.opts.damping * omega

    // Start at rest, fully zoomed out and centred.
    let s = 1
    let x = 0.5
    let y = 0.5
    let vs = 0
    let vx = 0
    let vy = 0

    for (let i = 0; i < steps; i++) {
      const tMs = (i / TRACK_HZ) * 1000
      const target = this.targetAt(tMs)

      // Semi-implicit Euler: velocity first, then position. Stable at 120 Hz
      // for the frequencies we allow, and cheap enough to run over an hour of
      // footage without a noticeable pause.
      vs += (k * (target.scale - s) - c * vs) * this.dt
      vx += (k * (target.cx - x) - c * vx) * this.dt
      vy += (k * (target.cy - y) - c * vy) * this.dt
      s += vs * this.dt
      x += vx * this.dt
      y += vy * this.dt

      const clampedScale = Math.max(1, s)
      const { halfW, halfH } = cropExtents(
        this.framing.sourceAspect,
        this.framing.outAspect,
        clampedScale,
      )
      // Clamping inside the loop, not after it, so the spring integrates from
      // a position it can actually reach instead of fighting a wall.
      const clamped = clampCenter(x, y, halfW, halfH)
      x = clamped.cx
      y = clamped.cy
      this.scales[i] = clampedScale
      this.xs[i] = clamped.cx
      this.ys[i] = clamped.cy
    }
  }

  /** Linearly interpolates the trajectory at an arbitrary time in ms. */
  sample(tMs: number): ZoomFrame {
    const last = this.scales.length - 1
    const pos = Math.min(last, Math.max(0, (tMs / 1000) * TRACK_HZ))
    const i = Math.floor(pos)
    const j = Math.min(last, i + 1)
    const f = pos - i
    return {
      scale: this.scales[i] + (this.scales[j] - this.scales[i]) * f,
      cx: this.xs[i] + (this.xs[j] - this.xs[i]) * f,
      cy: this.ys[i] + (this.ys[j] - this.ys[i]) * f,
    }
  }
}

/** Convenience: telemetry in, ready-to-sample camera path out. */
export function buildZoomTrack(
  telemetry: Telemetry,
  opts: ZoomOptions = DEFAULT_ZOOM_OPTIONS,
  segments?: ZoomSegment[],
  framing: TrackFraming = DEFAULT_FRAMING,
): ZoomTrack {
  const segs = segments ?? generateSegments(telemetry.clicks, opts)
  return new ZoomTrack(telemetry.duration, segs, opts, framing, telemetry.cursor)
}
