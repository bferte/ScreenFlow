import type { DrawFrame } from './compositor'

export type AvatarShape = 'circle' | 'rounded'
export type AvatarCorner = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'

export interface AvatarConfig {
  enabled: boolean
  imagePath: string | null
  shape: AvatarShape
  corner: AvatarCorner
  /** Diameter as a fraction of output height. */
  sizePct: number
  /** Gap from the frame edges, as a fraction of output height. */
  marginPct: number
  borderWidth: number
  borderColor: string
  /** Hide the avatar unless a voiceover cue is speaking. */
  onlyWhileSpeaking: boolean
}

export const DEFAULT_AVATAR_CONFIG: AvatarConfig = {
  enabled: false,
  imagePath: null,
  shape: 'circle',
  corner: 'bottom-left',
  sizePct: 0.22,
  marginPct: 0.035,
  borderWidth: 4,
  borderColor: '#8b8cf9',
  onlyWhileSpeaking: false,
}

/**
 * Supplies the avatar frame at a timeline instant.
 *
 * Deliberately an interface rather than an image: a talking-head clip generated
 * from the voiceover audio is a *sequence*, and it has to be addressable by
 * time exactly like the still is. Swapping `StaticAvatar` for a video-backed
 * implementation must not touch the compositor at all.
 *
 * Whatever backs it, `imageAt` has to stay a pure function of `t` — invariant 1
 * applies here as much as to the camera.
 */
export interface AvatarSource {
  readonly ready: boolean
  imageAt(tMs: number): CanvasImageSource | null
  dispose(): void
}

/** A single still image, shown for the whole timeline. */
export class StaticAvatar implements AvatarSource {
  private img: HTMLImageElement
  ready = false

  constructor(url: string) {
    this.img = new Image()
    this.img.crossOrigin = 'anonymous'
    this.img.onload = () => {
      this.ready = true
    }
    this.img.onerror = () => {
      console.error('[Avatar] image illisible', url)
    }
    this.img.src = url
  }

  imageAt(): CanvasImageSource | null {
    return this.ready ? this.img : null
  }

  dispose() {
    this.img.removeAttribute('src')
    this.ready = false
  }
}

/**
 * Placeholder for a generated talking head.
 *
 * A provider (SadTalker, LivePortrait, D-ID…) returns one video per voiceover
 * cue, lip-synced to that cue's audio. Since the cue already carries its
 * timeline position, the frame at `t` is the clip seeked to `t - cue.startMs` —
 * the same slaving pattern MediaPool uses, and the reason `imageAt` takes a
 * timestamp rather than returning a fixed image.
 *
 * Not wired up: it needs the offline seek loop the exporter uses, so that
 * exported frames come from an exact seek rather than whatever the element
 * happened to be showing.
 */
export interface TalkingHeadClip {
  cueId: string
  startMs: number
  durationMs: number
  videoPath: string
}

/** Where the avatar lands on the canvas, in output pixels. */
export function avatarRect(config: AvatarConfig, frame: DrawFrame) {
  const size = config.sizePct * frame.outHeight
  const margin = config.marginPct * frame.outHeight
  const right = config.corner.endsWith('right')
  const bottom = config.corner.startsWith('bottom')
  return {
    x: right ? frame.outWidth - size - margin : margin,
    y: bottom ? frame.outHeight - size - margin : margin,
    size,
  }
}

/** Draws the avatar clipped to its shape, with an optional ring. */
export function drawAvatar(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  config: AvatarConfig,
  frame: DrawFrame,
) {
  const { x, y, size } = avatarRect(config, frame)
  const radius = config.shape === 'circle' ? size / 2 : size * 0.18

  ctx.save()
  ctx.beginPath()
  if (config.shape === 'circle') {
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
  } else {
    ctx.roundRect(x, y, size, size, radius)
  }
  ctx.closePath()

  // Shadow before clipping: a shadow drawn inside the clip would be invisible.
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
  ctx.shadowBlur = size * 0.12
  ctx.fillStyle = '#000'
  ctx.fill()
  ctx.restore()

  ctx.clip()

  // Cover-fit the source so a non-square portrait is not stretched.
  const sw = typeof source === 'object' && 'width' in source ? Number(source.width) : size
  const sh = typeof source === 'object' && 'height' in source ? Number(source.height) : size
  const cover = Math.max(size / (sw || size), size / (sh || size))
  const dw = (sw || size) * cover
  const dh = (sh || size) * cover
  ctx.drawImage(source, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh)
  ctx.restore()

  if (config.borderWidth > 0) {
    ctx.save()
    ctx.strokeStyle = config.borderColor
    ctx.lineWidth = config.borderWidth
    ctx.beginPath()
    if (config.shape === 'circle') {
      ctx.arc(x + size / 2, y + size / 2, size / 2 - config.borderWidth / 2, 0, Math.PI * 2)
    } else {
      ctx.roundRect(
        x + config.borderWidth / 2,
        y + config.borderWidth / 2,
        size - config.borderWidth,
        size - config.borderWidth,
        radius,
      )
    }
    ctx.stroke()
    ctx.restore()
  }
}
