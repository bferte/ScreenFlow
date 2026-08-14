import { useCallback, useRef, useState } from 'react'
import type { ClickEvent } from '@/types/telemetry'
import { MIN_SEGMENT_MS, type ZoomSegment } from '@/lib/zoom-engine'
import type { PlacedClip } from '@/lib/sequence'
import { blockEndMs, type VoiceoverBlock } from '@/types/voiceover'

/** A zoom segment lifted from clip-local time onto the timeline. */
export interface TimelineSegment extends ZoomSegment {
  clipId: string
}

/** A click marker lifted onto the timeline. */
export interface TimelineClick extends ClickEvent {
  timelineT: number
}

interface Props {
  durationMs: number
  currentMs: number
  clicks: TimelineClick[]
  segments: TimelineSegment[]
  placed: PlacedClip[]
  blocks: VoiceoverBlock[]
  onSeek: (ms: number) => void
  selectedId: string | null
  onSelect: (id: string | null) => void
  selectedClipId: string | null
  onSelectClip: (id: string | null) => void
  selectedBlockId: string | null
  onSelectBlock: (id: string | null) => void
  /** Called continuously while a block is dragged. */
  onMoveBlock: (id: string, timelineOffsetMs: number) => void
  /** Called continuously while a zoom's edge is dragged, in timeline time. */
  onResizeSegment: (clipId: string, id: string, startT: number, endT: number) => void
}

/** How close, in pixels, a dragged edge must be to snap. */
const SNAP_PX = 7

export default function Timeline({
  durationMs,
  currentMs,
  clicks,
  segments,
  placed,
  blocks,
  onSeek,
  selectedId,
  onSelect,
  selectedClipId,
  onSelectClip,
  selectedBlockId,
  onSelectBlock,
  onMoveBlock,
  onResizeSegment,
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [snapped, setSnapped] = useState(false)

  const pct = (ms: number) => (durationMs > 0 ? (ms / durationMs) * 100 : 0)

  /**
   * Clamps a time span to what the track can show.
   *
   * A zoom segment ends `holdMs` after its last click, so a click near the end
   * of a recording legitimately produces an `endT` past the duration — the
   * camera simply never gets sampled there. Truncating it in the engine would
   * shorten the release; it is only the *drawing* that must stay inside the
   * lane, or the block spills over the panel next to it.
   */
  const span = (startT: number, endT: number) => {
    const start = Math.min(Math.max(startT, 0), durationMs)
    const end = Math.min(Math.max(endT, start), durationMs)
    return { left: pct(start), width: pct(end - start) }
  }

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current
      if (!el || durationMs <= 0) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      onSeek(ratio * durationMs)
    },
    [durationMs, onSeek],
  )

  const handlePointerDown = (e: React.PointerEvent) => {
    seekFromEvent(e.clientX)
    const move = (ev: PointerEvent) => seekFromEvent(ev.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * Drags a voiceover block along the timeline.
   *
   * Only `timelineOffsetMs` changes — the cached audio is never touched, so a
   * drag can never cost a TTS call. Snapping targets the places a narration
   * actually wants to land: the start, the playhead, every clip boundary and
   * the edges of neighbouring blocks.
   */
  const startBlockDrag = (e: React.PointerEvent, block: VoiceoverBlock) => {
    e.stopPropagation()
    e.preventDefault()
    onSelectBlock(block.id)

    const el = trackRef.current
    if (!el || durationMs <= 0) return
    const rect = el.getBoundingClientRect()
    const msPerPx = durationMs / rect.width
    const grabOffset = e.clientX - rect.left - block.timelineOffsetMs / msPerPx

    const targets = [
      0,
      currentMs,
      ...placed.flatMap((p) => [p.startT, p.endT]),
      ...blocks.filter((b) => b.id !== block.id).flatMap((b) => [b.timelineOffsetMs, blockEndMs(b)]),
    ]
    const snapMs = SNAP_PX * msPerPx
    const maxStart = Math.max(0, durationMs - block.durationMs)

    setDragging(block.id)

    const move = (ev: PointerEvent) => {
      let next = (ev.clientX - rect.left - grabOffset) * msPerPx
      next = Math.min(maxStart, Math.max(0, next))

      // Snap whichever edge is closest to a target.
      let best: number | null = null
      let bestDistance = snapMs
      for (const target of targets) {
        for (const [edge, candidate] of [
          [next, target],
          [next + block.durationMs, target - block.durationMs],
        ] as const) {
          const d = Math.abs(edge - target)
          if (d < bestDistance) {
            bestDistance = d
            best = candidate
          }
        }
      }
      const snapping = best !== null
      if (best !== null) next = Math.min(maxStart, Math.max(0, best))

      setSnapped(snapping)
      onMoveBlock(block.id, Math.round(next))
    }

    const up = () => {
      setDragging(null)
      setSnapped(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * Drags one edge of a zoom segment.
   *
   * Only the dragged edge moves — the other is the anchor — and the pair is
   * kept `MIN_SEGMENT_MS` apart so a segment can never be dragged inside out.
   * Times are reported in timeline coordinates; turning them back into clip
   * time is the editor's job, since only it knows how the clip is placed.
   */
  const startSegmentResize = (
    e: React.PointerEvent,
    segment: TimelineSegment,
    edge: 'start' | 'end',
  ) => {
    e.stopPropagation()
    e.preventDefault()
    onSelect(segment.id)

    const el = trackRef.current
    if (!el || durationMs <= 0) return
    const rect = el.getBoundingClientRect()
    const msPerPx = durationMs / rect.width

    const move = (ev: PointerEvent) => {
      const at = Math.min(durationMs, Math.max(0, (ev.clientX - rect.left) * msPerPx))
      const startT =
        edge === 'start' ? Math.min(at, segment.endT - MIN_SEGMENT_MS) : segment.startT
      const endT = edge === 'end' ? Math.max(at, segment.startT + MIN_SEGMENT_MS) : segment.endT
      onResizeSegment(segment.clipId, segment.id, Math.round(startT), Math.round(endT))
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const downs = clicks.filter((c) => c.pressed)

  return (
    <div className="select-none px-6 py-4">
      {/* Clip lane: how the sequence is assembled. */}
      <div className="relative mb-1.5 flex h-7 overflow-hidden rounded-md border border-edge bg-surface">
        {placed.map((p) => {
          const isRecording = p.clip.kind === 'recording'
          const label =
            p.clip.kind === 'recording' ? p.clip.manifest.name || 'Capture' : p.clip.name
          return (
            <button
              key={p.clip.id}
              onClick={() => onSelectClip(p.clip.id === selectedClipId ? null : p.clip.id)}
              style={{ width: `${pct(p.endT - p.startT)}%` }}
              className={`min-w-0 border-r border-edge/60 px-2 text-left text-[10px] transition-colors last:border-r-0 ${
                p.clip.id === selectedClipId
                  ? 'bg-indigo-500/40 text-indigo-100'
                  : isRecording
                    ? 'bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/25'
                    : 'bg-neutral-600/25 text-neutral-300 hover:bg-neutral-600/40'
              }`}
              title={`${label} · ${((p.endT - p.startT) / 1000).toFixed(2)}s`}
            >
              <span className="block truncate">{label}</span>
            </button>
          )
        })}
      </div>

      {/* Voiceover lane: blocks are dragged here. */}
      <div className="relative mb-1.5 h-8 rounded-md border border-edge bg-surface">
        {blocks.length === 0 && (
          <span className="pointer-events-none absolute inset-0 flex items-center pl-2 text-[10px] text-neutral-600">
            Voix-off — génère un bloc pour le poser ici
          </span>
        )}
        {blocks.map((block) => (
          <div
            key={block.id}
            onPointerDown={(e) => startBlockDrag(e, block)}
            style={{
              left: `${span(block.timelineOffsetMs, blockEndMs(block)).left}%`,
              // A hair of width even for a block too short to see, but never
              // past the end: a narration longer than the timeline is pinned to
              // offset 0 and would otherwise draw wider than the lane.
              width: `${Math.max(0.5, span(block.timelineOffsetMs, blockEndMs(block)).width)}%`,
            }}
            className={`absolute inset-y-1 flex cursor-grab items-center overflow-hidden rounded border px-1.5 transition-colors active:cursor-grabbing ${
              dragging === block.id
                ? snapped
                  ? 'border-amber-300 bg-amber-500/40'
                  : 'border-emerald-300 bg-emerald-500/45'
                : block.id === selectedBlockId
                  ? 'border-emerald-300 bg-emerald-500/40'
                  : 'border-emerald-500/60 bg-emerald-500/20 hover:bg-emerald-500/30'
            }`}
            title={`${block.text}\n${(block.timelineOffsetMs / 1000).toFixed(2)}s → ${(
              blockEndMs(block) / 1000
            ).toFixed(2)}s`}
          >
            <span className="truncate text-[10px] text-emerald-50">{block.text || '…'}</span>
          </div>
        ))}
      </div>

      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        className="relative h-16 cursor-pointer rounded-lg border border-edge bg-surface"
      >
        {/* Clip boundaries, so zooms read against the cuts. */}
        {placed.slice(1).map((p) => (
          <div
            key={`edge-${p.clip.id}`}
            style={{ left: `${pct(p.startT)}%` }}
            className="pointer-events-none absolute inset-y-0 w-px bg-edge"
          />
        ))}

        {/* Zoom segments */}
        {segments.map((s) => (
          <div
            key={`${s.clipId}-${s.id}`}
            onPointerDown={(e) => {
              e.stopPropagation()
              onSelect(s.id === selectedId ? null : s.id)
            }}
            style={{
              left: `${span(s.startT, s.endT).left}%`,
              width: `${span(s.startT, s.endT).width}%`,
            }}
            className={`absolute top-2 h-7 rounded border transition-colors ${
              s.id === selectedId
                ? 'border-indigo-300 bg-indigo-500/50'
                : 'border-indigo-500/60 bg-indigo-500/25 hover:bg-indigo-500/40'
            }`}
            title={
              `Zoom ×${s.scale.toFixed(1)} · ${s.clickCount} clic(s)` +
              (s.auto ? '' : ' · réglé à la main') +
              '\nTire un bord pour changer la durée'
            }
          >
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] font-medium text-indigo-100">
              ×{s.scale.toFixed(1)}
            </span>
            {/* Resize handles. Wider than they look: a 3 px target is a fight. */}
            {(['start', 'end'] as const).map((edge) => (
              <span
                key={edge}
                onPointerDown={(e) => startSegmentResize(e, s, edge)}
                className={`absolute inset-y-0 w-2 cursor-ew-resize ${
                  edge === 'start' ? '-left-1' : '-right-1'
                }`}
              >
                <span
                  className={`absolute inset-y-1 w-0.5 rounded bg-indigo-200/70 ${
                    edge === 'start' ? 'left-0.5' : 'right-0.5'
                  } ${s.id === selectedId ? 'opacity-100' : 'opacity-0'}`}
                />
              </span>
            ))}
          </div>
        ))}

        {/* Click markers */}
        <div className="absolute inset-x-0 bottom-2 h-5">
          {downs.map((c, i) => (
            <span
              key={i}
              style={{ left: `${pct(c.timelineT)}%` }}
              className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400"
              title={`Clic ${c.button} à ${(c.timelineT / 1000).toFixed(2)}s`}
            />
          ))}
        </div>

        {/* Playhead */}
        <div
          style={{ left: `${pct(currentMs)}%` }}
          className="pointer-events-none absolute inset-y-0 w-px bg-white"
        >
          <div className="absolute -left-[3px] top-0 h-1.5 w-1.5 rounded-full bg-white" />
        </div>
      </div>

      <div className="mt-2 flex justify-between text-[11px] tabular-nums text-neutral-500">
        <span>0:00</span>
        <span>{(durationMs / 1000).toFixed(2)}s</span>
      </div>
    </div>
  )
}
