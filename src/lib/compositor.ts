import type { FramingMode } from '@/types/project'

export interface Camera {
  scale: number
  cx: number
  cy: number
}

export const IDENTITY_CAMERA: Camera = { scale: 1, cx: 0.5, cy: 0.5 }

/**
 * Geometry of one composited frame.
 *
 * Source and output dimensions are tracked separately on purpose: the preview
 * renders at the recording's native size, while an export may target 1080p
 * from a 1440p capture. The destination rect is separate again, because a
 * letterboxed 16:9 source inside a 9:16 frame does not fill the canvas.
 * Anything mapping telemetry onto the frame must go through all three.
 */
export interface DrawFrame {
  scale: number
  /** Crop rectangle sampled from the source, in source pixels. */
  sx: number
  sy: number
  sw: number
  sh: number
  /** Where that crop lands on the canvas. */
  dx: number
  dy: number
  dw: number
  dh: number
  sourceWidth: number
  sourceHeight: number
  outWidth: number
  outHeight: number
}

export type OverlayRenderer = (
  ctx: CanvasRenderingContext2D,
  tMs: number,
  frame: DrawFrame,
) => void

/** Maps a normalised telemetry point to output pixels, through crop and letterbox. */
export function toCanvas(nx: number, ny: number, f: DrawFrame) {
  return {
    x: f.dx + ((nx * f.sourceWidth - f.sx) / f.sw) * f.dw,
    y: f.dy + ((ny * f.sourceHeight - f.sy) / f.sh) * f.dh,
  }
}

/**
 * Normalised half-extents of the crop window at a given zoom.
 *
 * Exported because ZoomTrack needs exactly these to clamp the camera. The
 * clamp has to happen *inside* the spring integration — clamping the output
 * afterwards would leave the spring pulling against a wall and produce a
 * camera that sticks to the edge instead of settling.
 */
export function cropExtents(sourceAspect: number, outAspect: number, scale: number) {
  const s = Math.max(scale, 1)
  if (outAspect < sourceAspect) {
    // Output is taller than the source: full height, narrower slice.
    return { halfW: outAspect / sourceAspect / s / 2, halfH: 1 / s / 2 }
  }
  return { halfW: 1 / s / 2, halfH: sourceAspect / outAspect / s / 2 }
}

export function computeFrame(
  camera: Camera,
  sourceWidth: number,
  sourceHeight: number,
  outWidth: number,
  outHeight: number,
  mode: FramingMode,
): DrawFrame {
  const sourceAspect = sourceWidth / sourceHeight
  const outAspect = outWidth / outHeight

  if (mode !== 'crop') {
    // Letterbox: the whole source is shown, zoom still applies inside it.
    const scale = Math.max(camera.scale, 1)
    const sw = sourceWidth / scale
    const sh = sourceHeight / scale
    const fit = Math.min(outWidth / sourceWidth, outHeight / sourceHeight)
    const dw = sourceWidth * fit
    const dh = sourceHeight * fit
    return {
      scale,
      sx: camera.cx * sourceWidth - sw / 2,
      sy: camera.cy * sourceHeight - sh / 2,
      sw,
      sh,
      dx: (outWidth - dw) / 2,
      dy: (outHeight - dh) / 2,
      dw,
      dh,
      sourceWidth,
      sourceHeight,
      outWidth,
      outHeight,
    }
  }

  const { halfW, halfH } = cropExtents(sourceAspect, outAspect, camera.scale)
  const sw = halfW * 2 * sourceWidth
  const sh = halfH * 2 * sourceHeight

  // The camera is already clamped against these same extents, so the crop is
  // guaranteed inside the source; re-clamping here would mask a track bug.
  return {
    scale: Math.max(camera.scale, 1),
    sx: camera.cx * sourceWidth - sw / 2,
    sy: camera.cy * sourceHeight - sh / 2,
    sw,
    sh,
    dx: 0,
    dy: 0,
    dw: outWidth,
    dh: outHeight,
    sourceWidth,
    sourceHeight,
    outWidth,
    outHeight,
  }
}

/**
 * Fills the letterbox bars behind a fitted frame.
 *
 * The blurred variant redraws the source scaled to *cover* the canvas with a
 * heavy blur, which is the standard Shorts treatment: it keeps the bars alive
 * without competing with the content.
 */
function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  frame: DrawFrame,
  mode: FramingMode,
) {
  const { outWidth, outHeight, sourceWidth, sourceHeight } = frame

  if (mode === 'fit-gradient') {
    const gradient = ctx.createLinearGradient(0, 0, 0, outHeight)
    gradient.addColorStop(0, '#1b1c22')
    gradient.addColorStop(0.5, '#2a2c36')
    gradient.addColorStop(1, '#1b1c22')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, outWidth, outHeight)
    return
  }

  const cover = Math.max(outWidth / sourceWidth, outHeight / sourceHeight)
  const cw = sourceWidth * cover
  const ch = sourceHeight * cover

  ctx.save()
  ctx.filter = 'blur(48px) brightness(0.55)'
  ctx.drawImage(source, (outWidth - cw) / 2, (outHeight - ch) / 2, cw, ch)
  ctx.restore()
}

/**
 * The single place a finished frame is produced.
 *
 * Both the live player and the exporter call this, which is what makes the
 * exported file match the preview rather than merely resemble it.
 */
export function drawComposite(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  camera: Camera,
  tMs: number,
  sourceWidth: number,
  sourceHeight: number,
  outWidth: number,
  outHeight: number,
  mode: FramingMode,
  overlay?: OverlayRenderer,
): DrawFrame {
  const frame = computeFrame(camera, sourceWidth, sourceHeight, outWidth, outHeight, mode)

  if (mode === 'crop') {
    ctx.drawImage(source, frame.sx, frame.sy, frame.sw, frame.sh, 0, 0, outWidth, outHeight)
  } else {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, outWidth, outHeight)
    drawBackdrop(ctx, source, frame, mode)
    ctx.drawImage(source, frame.sx, frame.sy, frame.sw, frame.sh, frame.dx, frame.dy, frame.dw, frame.dh)
  }

  overlay?.(ctx, tMs, frame)
  return frame
}
