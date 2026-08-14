import { useState } from 'react'
import Slider from './Slider'
import { clipDuration, type Clip, type MediaClip } from '@/types/project'

interface Props {
  clips: Clip[]
  setClips: React.Dispatch<React.SetStateAction<Clip[]>>
  selectedClipId: string | null
  onSelectClip: (id: string | null) => void
  /** Splits the clip under the playhead, so media can be inserted mid-capture. */
  onSplit: () => void
  canSplit: boolean
}

let counter = 0
export const nextClipId = () => `clip-${Date.now().toString(36)}-${counter++}`

export default function ClipsPanel({
  clips,
  setClips,
  selectedClipId,
  onSelectClip,
  onSplit,
  canSplit,
}: Props) {
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** `number` inserts after that index; the keywords go to the ends. */
  async function importMedia(position: 'start' | 'end' | number) {
    setImporting(true)
    setError(null)
    try {
      const files = await window.screenflow.importMedia()
      if (files.length === 0) return

      const added: MediaClip[] = files.map((f) => ({
        kind: 'media',
        id: nextClipId(),
        path: f.path,
        name: f.name,
        inMs: 0,
        outMs: f.durationMs,
        volume: 1,
        width: f.width,
        height: f.height,
        hasAudio: f.hasAudio,
        hasVideo: f.hasVideo,
        sourceDurationMs: f.durationMs,
      }))

      const unreadable = added.filter((c) => c.sourceDurationMs <= 0)
      if (unreadable.length > 0) {
        setError(
          `Durée illisible pour : ${unreadable.map((c) => c.name).join(', ')}. ` +
            'Le fichier est peut-être corrompu ou dans un format non supporté.',
        )
      }

      const usable = added.filter((c) => c.sourceDurationMs > 0)
      if (usable.length === 0) return

      setClips((prev) => {
        if (position === 'start') return [...usable, ...prev]
        if (position === 'end') return [...prev, ...usable]
        const at = Math.min(prev.length, position + 1)
        return [...prev.slice(0, at), ...usable, ...prev.slice(at)]
      })
      onSelectClip(usable[0].id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  function move(id: string, delta: number) {
    setClips((prev) => {
      const i = prev.findIndex((c) => c.id === id)
      const j = i + delta
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  function remove(id: string) {
    setClips((prev) => prev.filter((c) => c.id !== id))
    if (selectedClipId === id) onSelectClip(null)
  }

  const selected = clips.find((c) => c.id === selectedClipId) ?? null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => importMedia('start')}
          disabled={importing}
          className="btn-ghost text-[11px]"
        >
          + Intro
        </button>
        <button
          onClick={() => importMedia('end')}
          disabled={importing}
          className="btn-ghost text-[11px]"
        >
          + Outro
        </button>
      </div>

      <button onClick={onSplit} disabled={!canSplit} className="btn-ghost w-full text-[11px]">
        ✂ Couper au curseur
      </button>
      <p className="-mt-2 text-[10px] leading-relaxed text-neutral-500">
        Coupe le clip sous la tête de lecture en deux, pour pouvoir insérer un média
        au milieu d'une capture.
      </p>

      {error && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          {error}
        </p>
      )}

      <div className="space-y-1.5">
        {clips.map((clip, i) => (
          <div
            key={clip.id}
            onClick={() => onSelectClip(clip.id === selectedClipId ? null : clip.id)}
            className={`cursor-pointer rounded border px-2.5 py-2 transition-colors ${
              clip.id === selectedClipId
                ? 'border-indigo-500 bg-indigo-500/15'
                : 'border-edge bg-surface hover:border-neutral-600'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-[11px] text-neutral-300">
                {clip.kind === 'recording' ? clip.manifest.name || 'Capture écran' : clip.name}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-neutral-500">
                {(clipDuration(clip) / 1000).toFixed(1)}s
              </span>
            </div>
            <div className="mt-1.5 flex gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  move(clip.id, -1)
                }}
                disabled={i === 0}
                className="rounded border border-edge px-1.5 text-[10px] text-neutral-400 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  move(clip.id, 1)
                }}
                disabled={i === clips.length - 1}
                className="rounded border border-edge px-1.5 text-[10px] text-neutral-400 disabled:opacity-30"
              >
                ↓
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void importMedia(i)
                }}
                disabled={importing}
                className="rounded border border-edge px-1.5 text-[10px] text-neutral-400 disabled:opacity-30"
                title="Insérer un média juste après ce clip"
              >
                + après
              </button>
              {/* Splitting a capture produces two recording clips, so halves
                  must be removable too — only the last clip is protected. */}
              {clips.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(clip.id)
                  }}
                  className="ml-auto rounded border border-edge px-1.5 text-[10px] text-red-400"
                >
                  Retirer
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <>
          <hr className="border-edge" />
          <p className="label">Clip sélectionné</p>
          <Slider
            label="Volume"
            value={selected.volume}
            min={0}
            max={2}
            step={0.05}
            format={(v) => `${Math.round(v * 100)} %`}
            onChange={(volume) =>
              setClips((prev) =>
                prev.map((c) => (c.id === selected.id ? { ...c, volume } : c)),
              )
            }
          />
          {selected.kind === 'media' && (
            <TrimControls
              clip={selected}
              onChange={(patch) =>
                setClips((prev) =>
                  prev.map((c) =>
                    // Narrowed explicitly: spreading a MediaClip patch onto the
                    // union would widen `kind` and break the discriminant.
                    c.id === selected.id && c.kind === 'media' ? { ...c, ...patch } : c,
                  ),
                )
              }
            />
          )}
        </>
      )}
    </div>
  )
}

function TrimControls({
  clip,
  onChange,
}: {
  clip: MediaClip
  onChange: (patch: Partial<MediaClip>) => void
}) {
  return (
    <>
      <Slider
        label="Début"
        value={clip.inMs}
        min={0}
        max={Math.max(0, clip.sourceDurationMs - 100)}
        step={50}
        format={(v) => `${(v / 1000).toFixed(2)} s`}
        // Keep at least 100 ms of clip so it never collapses to nothing.
        onChange={(inMs) => onChange({ inMs, outMs: Math.max(inMs + 100, clip.outMs) })}
      />
      <Slider
        label="Fin"
        value={clip.outMs}
        min={100}
        max={clip.sourceDurationMs}
        step={50}
        format={(v) => `${(v / 1000).toFixed(2)} s`}
        onChange={(outMs) => onChange({ outMs, inMs: Math.min(outMs - 100, clip.inMs) })}
      />
    </>
  )
}
