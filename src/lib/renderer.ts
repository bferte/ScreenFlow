import type { Sequence } from './sequence'
import type { ZoomTrack } from './zoom-engine'
import {
  drawComposite,
  IDENTITY_CAMERA,
  type Camera,
  type DrawFrame,
  type OverlayRenderer,
} from './compositor'
import type { FramingMode } from '@/types/project'
import { drawAvatar, type AvatarConfig, type AvatarSource } from './avatar'

/** Timeline-level decorations, i.e. everything that outlives a cut. */
export interface SequenceOverlays {
  avatar?: {
    config: AvatarConfig
    source: AvatarSource | null
    /** True while a voiceover cue is speaking, for `onlyWhileSpeaking`. */
    isSpeaking: (tMs: number) => boolean
  }
}

/** Everything derived from a clip that the renderer needs at draw time. */
export interface ClipRuntime {
  /** Camera path; null for imported media, which gets no automatic zoom. */
  track: ZoomTrack | null
  /** Annotations; only recordings have telemetry to draw from. */
  overlay?: OverlayRenderer
  sourceWidth: number
  sourceHeight: number
  hasVideo: boolean
}

/** Supplies the decoded frame for a clip. Preview and export differ here only. */
export type SourceProvider = (clipId: string) => CanvasImageSource | null

/**
 * Draws the sequence at a given timeline instant.
 *
 * The player and the exporter both go through this one method. They differ
 * only in how they get decoded frames — the player keeps elements playing, the
 * exporter seeks them — so geometry, framing and overlays cannot drift apart
 * between preview and output.
 */
export class SequenceRenderer {
  constructor(
    readonly sequence: Sequence,
    readonly runtimes: Map<string, ClipRuntime>,
    readonly framing: FramingMode,
    readonly overlays: SequenceOverlays = {},
  ) {}

  render(
    ctx: CanvasRenderingContext2D,
    tMs: number,
    outWidth: number,
    outHeight: number,
    getSource: SourceProvider,
  ): DrawFrame | null {
    const resolved = this.sequence.resolve(tMs)
    const clipId = resolved?.placed.clip.id ?? null
    const runtime = clipId ? this.runtimes.get(clipId) : undefined
    const source = clipId ? getSource(clipId) : null

    let frame: DrawFrame | null = null

    if (resolved && runtime && runtime.hasVideo && source) {
      const camera: Camera = runtime.track ? runtime.track.sample(resolved.localMs) : IDENTITY_CAMERA
      frame = drawComposite(
        ctx,
        source,
        camera,
        // Overlays read telemetry, which is in clip-local time, not timeline time.
        resolved.localMs,
        runtime.sourceWidth,
        runtime.sourceHeight,
        outWidth,
        outHeight,
        this.framing,
        runtime.overlay,
      )
    } else {
      // An audio-only clip, or one whose media has not decoded yet, still has
      // to occupy its slot rather than leaving the previous frame frozen.
      this.fillEmpty(ctx, outWidth, outHeight)
    }

    // Timeline-level, so it survives cuts and stays visible over a jingle or a
    // black frame. Drawn here rather than in drawComposite because it belongs
    // to the sequence, not to any one clip — and this method is still the
    // single path shared by the player and the exporter.
    this.drawTimelineOverlays(ctx, tMs, frame ?? this.emptyFrame(outWidth, outHeight))

    return frame
  }

  private drawTimelineOverlays(ctx: CanvasRenderingContext2D, tMs: number, frame: DrawFrame) {
    const avatar = this.overlays.avatar
    if (!avatar || !avatar.config.enabled || !avatar.source) return
    if (avatar.config.onlyWhileSpeaking && !avatar.isSpeaking(tMs)) return

    const image = avatar.source.imageAt(tMs)
    if (image) drawAvatar(ctx, image, avatar.config, frame)
  }

  /** Geometry for overlays when no clip frame was produced. */
  private emptyFrame(outWidth: number, outHeight: number): DrawFrame {
    return {
      scale: 1,
      sx: 0,
      sy: 0,
      sw: outWidth,
      sh: outHeight,
      dx: 0,
      dy: 0,
      dw: outWidth,
      dh: outHeight,
      sourceWidth: outWidth,
      sourceHeight: outHeight,
      outWidth,
      outHeight,
    }
  }

  private fillEmpty(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
  }
}

/** Output pixel dimensions for a given aspect and target height. */
export function outputSize(aspect: '16:9' | '9:16', height: number) {
  const ratio = aspect === '9:16' ? 9 / 16 : 16 / 9
  // Even dimensions are mandatory for yuv420p; libx264 rejects odd ones.
  const h = Math.round(height / 2) * 2
  const w = Math.round((h * ratio) / 2) * 2
  return { width: w, height: h }
}
