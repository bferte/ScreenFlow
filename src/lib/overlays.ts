import type { ClickEvent, CursorSample, Telemetry } from '@/types/telemetry'
import { toCanvas, type DrawFrame } from './compositor'

export interface AnnotationOptions {
  rings: boolean
  /** Ring lifetime in ms. */
  ringDurationMs: number
  /** Final ring radius as a fraction of output height. */
  ringRadius: number
  ringColor: string

  spotlight: boolean
  /** Lit radius as a fraction of output height. */
  spotlightRadius: number
  /** How dark the surroundings get, 0..1. */
  spotlightDarkness: number
  /** Fade in/out at the edges of a zoom segment, in ms. */
  spotlightFadeMs: number
  /** Follow the live cursor instead of the segment's focus point. */
  spotlightFollowsCursor: boolean
}

export const DEFAULT_ANNOTATION_OPTIONS: AnnotationOptions = {
  rings: true,
  ringDurationMs: 620,
  ringRadius: 0.055,
  ringColor: '#8b8cf9',

  spotlight: false,
  spotlightRadius: 0.22,
  spotlightDarkness: 0.55,
  spotlightFadeMs: 320,
  spotlightFollowsCursor: true,
}

/* ------------------------------------------------------------------ *
 * Telemetry lookup
 * ------------------------------------------------------------------ */

/**
 * Cursor position at an arbitrary time, interpolated between samples.
 *
 * Samples are sorted by construction, so this binary-searches rather than
 * scanning — the draw loop calls it every frame and a linear scan over a long
 * recording would show up as jitter.
 */
export function sampleCursor(cursor: CursorSample[], tMs: number): { nx: number; ny: number } | null {
  if (cursor.length === 0) return null
  if (tMs <= cursor[0].t) return { nx: cursor[0].nx, ny: cursor[0].ny }
  const last = cursor[cursor.length - 1]
  if (tMs >= last.t) return { nx: last.nx, ny: last.ny }

  let lo = 0
  let hi = cursor.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cursor[mid].t <= tMs) lo = mid
    else hi = mid
  }

  const a = cursor[lo]
  const b = cursor[hi]
  const span = b.t - a.t
  const f = span > 0 ? (tMs - a.t) / span : 0
  return { nx: a.nx + (b.nx - a.nx) * f, ny: a.ny + (b.ny - a.ny) * f }
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

function drawRings(
  ctx: CanvasRenderingContext2D,
  tMs: number,
  frame: DrawFrame,
  clicks: ClickEvent[],
  opts: AnnotationOptions,
) {
  // Radius is kept constant in *output* space rather than multiplied by the
  // zoom, so a ring reads the same size whether the camera is in or out.
  const maxRadius = opts.ringRadius * frame.outHeight

  for (const click of clicks) {
    if (!click.pressed) continue
    const age = tMs - click.t
    if (age < 0 || age > opts.ringDurationMs) continue

    const p = age / opts.ringDurationMs
    const { x, y } = toCanvas(click.nx, click.ny, frame)

    ctx.save()
    ctx.globalAlpha = 1 - p
    ctx.strokeStyle = opts.ringColor
    ctx.lineWidth = Math.max(2, frame.outHeight * 0.004)
    ctx.beginPath()
    ctx.arc(x, y, maxRadius * easeOut(p), 0, Math.PI * 2)
    ctx.stroke()

    // A short filled flash on impact reads as the actual "click".
    if (p < 0.35) {
      ctx.globalAlpha = (1 - p / 0.35) * 0.28
      ctx.fillStyle = opts.ringColor
      ctx.beginPath()
      ctx.arc(x, y, maxRadius * 0.42, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }
}

function drawSpotlight(
  ctx: CanvasRenderingContext2D,
  frame: DrawFrame,
  centre: { nx: number; ny: number },
  intensity: number,
  opts: AnnotationOptions,
) {
  if (intensity <= 0.001) return

  const { x, y } = toCanvas(centre.nx, centre.ny, frame)
  const radius = opts.spotlightRadius * frame.outHeight

  ctx.save()
  // Paint the scrim, then erase a soft hole in it. Compositing this way keeps
  // the falloff smooth; stroking a ring of darkness would band visibly.
  ctx.fillStyle = `rgba(0, 0, 0, ${opts.spotlightDarkness * intensity})`
  ctx.fillRect(0, 0, frame.outWidth, frame.outHeight)

  const gradient = ctx.createRadialGradient(x, y, radius * 0.55, x, y, radius)
  gradient.addColorStop(0, 'rgba(0, 0, 0, 1)')
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

export interface SpotlightWindow {
  startT: number
  endT: number
  nx: number
  ny: number
}

/** Ramps the scrim in and out at the edges of a window instead of snapping. */
function spotlightIntensity(tMs: number, windows: SpotlightWindow[], fadeMs: number) {
  let best = 0
  for (const w of windows) {
    if (tMs < w.startT - fadeMs || tMs > w.endT + fadeMs) continue
    const rampIn = fadeMs > 0 ? (tMs - (w.startT - fadeMs)) / fadeMs : 1
    const rampOut = fadeMs > 0 ? (w.endT + fadeMs - tMs) / fadeMs : 1
    best = Math.max(best, Math.min(1, rampIn, rampOut))
  }
  return Math.max(0, best)
}

/**
 * Builds the overlay callback handed to CanvasPlayer. Everything it draws is a
 * pure function of the timestamp, so preview and export agree frame for frame.
 */
export function createOverlayRenderer(
  telemetry: Telemetry,
  windows: SpotlightWindow[],
  opts: AnnotationOptions,
) {
  return (ctx: CanvasRenderingContext2D, tMs: number, frame: DrawFrame) => {
    if (opts.spotlight) {
      const intensity = spotlightIntensity(tMs, windows, opts.spotlightFadeMs)
      if (intensity > 0) {
        const centre = opts.spotlightFollowsCursor
          ? sampleCursor(telemetry.cursor, tMs)
          : nearestWindow(tMs, windows)
        if (centre) drawSpotlight(ctx, frame, centre, intensity, opts)
      }
    }
    if (opts.rings) {
      drawRings(ctx, tMs, frame, telemetry.clicks, opts)
    }
  }
}

function nearestWindow(tMs: number, windows: SpotlightWindow[]) {
  let best: SpotlightWindow | null = null
  let bestDistance = Infinity
  for (const w of windows) {
    const d = tMs < w.startT ? w.startT - tMs : tMs > w.endT ? tMs - w.endT : 0
    if (d < bestDistance) {
      bestDistance = d
      best = w
    }
  }
  return best ? { nx: best.nx, ny: best.ny } : null
}
