import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { SequenceRenderer } from '@/lib/renderer'
import type { MediaPool } from '@/lib/media-pool'

export interface SequencePlayerHandle {
  play: () => void
  pause: () => void
  seek: (ms: number) => void
  readonly currentTimeMs: number
  readonly paused: boolean
}

interface Props {
  renderer: SequenceRenderer
  pool: MediaPool
  outWidth: number
  outHeight: number
  onTimeUpdate?: (ms: number) => void
  onPlayStateChange?: (playing: boolean) => void
  /** Per-frame hook for work that is not drawing, e.g. audio gain updates. */
  onFrame?: (timelineMs: number, localMs: number, clipId: string | null) => void
}

/**
 * Plays a multi-clip sequence onto a canvas.
 *
 * The clock is a plain accumulator advanced by requestAnimationFrame, not a
 * media element's currentTime. Nothing decodes across a cut, and audio-only
 * clips have no video clock at all, so the timeline has to advance on its own
 * and drag the media along.
 */
const SequencePlayer = forwardRef<SequencePlayerHandle, Props>(function SequencePlayer(
  { renderer, pool, outWidth, outHeight, onTimeUpdate, onPlayStateChange, onFrame },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef(0)

  const timeRef = useRef(0)
  const playingRef = useRef(false)
  const lastTickRef = useRef(0)
  const lastReportedRef = useRef(-Infinity)
  const lastDiagRef = useRef(0)

  const rendererRef = useRef(renderer)
  const poolRef = useRef(pool)
  const onFrameRef = useRef(onFrame)
  const onTimeRef = useRef(onTimeUpdate)
  const onPlayStateRef = useRef(onPlayStateChange)
  rendererRef.current = renderer
  poolRef.current = pool
  onFrameRef.current = onFrame
  onTimeRef.current = onTimeUpdate
  onPlayStateRef.current = onPlayStateChange

  const setPlaying = (value: boolean) => {
    if (playingRef.current === value) return
    playingRef.current = value
    lastTickRef.current = performance.now()
    onPlayStateRef.current?.(value)
  }

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        // Restart from the top rather than sitting stuck on the last frame.
        if (timeRef.current >= rendererRef.current.sequence.durationMs - 1) timeRef.current = 0
        setPlaying(true)
      },
      pause: () => setPlaying(false),
      seek: (ms: number) => {
        timeRef.current = Math.max(0, Math.min(ms, rendererRef.current.sequence.durationMs))
        lastReportedRef.current = -Infinity
      },
      get currentTimeMs() {
        return timeRef.current
      },
      get paused() {
        return !playingRef.current
      },
    }),
    [],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    lastTickRef.current = performance.now()

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw)

      const now = performance.now()
      const delta = now - lastTickRef.current
      lastTickRef.current = now

      const seq = rendererRef.current.sequence
      if (playingRef.current) {
        timeRef.current += delta
        if (timeRef.current >= seq.durationMs) {
          timeRef.current = seq.durationMs
          setPlaying(false)
        }
      }

      const t = timeRef.current
      const resolved = seq.resolve(t)
      const clipId = resolved?.placed.clip.id ?? null

      poolRef.current.sync(clipId, resolved?.localMs ?? 0, playingRef.current)
      onFrameRef.current?.(t, resolved?.localMs ?? 0, clipId)

      if (canvas.width !== outWidth || canvas.height !== outHeight) {
        canvas.width = outWidth
        canvas.height = outHeight
      }

      const drawn = rendererRef.current.render(ctx, t, outWidth, outHeight, (id) =>
        poolRef.current.get(id),
      )

      // Once a second while nothing renders, report why. A black canvas has
      // three possible causes and guessing between them is expensive.
      if (!drawn && now - lastDiagRef.current > 1000) {
        lastDiagRef.current = now
        const runtime = clipId ? rendererRef.current.runtimes.get(clipId) : undefined
        // Serialised, not passed as an object: the main process forwards
        // console output as a preformatted string, where an object collapses
        // to "[object Object]" and the diagnostic becomes worthless.
        console.warn(
          '[SequencePlayer] rien à dessiner ' +
            JSON.stringify({
              t: Math.round(t),
              clipId,
              knownRuntimes: [...rendererRef.current.runtimes.keys()],
              hasRuntime: !!runtime,
              hasVideo: runtime?.hasVideo ?? null,
              media: clipId ? poolRef.current.describe(clipId) : null,
            }),
        )
      }

      // The canvas redraws every frame, React does not need to. 60 state
      // updates a second would re-render the whole editor including its sliders.
      if (Math.abs(t - lastReportedRef.current) >= 50) {
        lastReportedRef.current = t
        onTimeRef.current?.(t)
      }
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [outWidth, outHeight])

  return (
    <canvas
      ref={canvasRef}
      className="max-h-full max-w-full rounded-lg border border-edge bg-black shadow-2xl"
    />
  )
})

export default SequencePlayer
