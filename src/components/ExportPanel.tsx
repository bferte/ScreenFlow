import { useCallback, useRef, useState } from 'react'
import Slider from './Slider'
import {
  DEFAULT_EXPORT_OPTIONS,
  runExport,
  type ExportOptions,
  type ExportProgress,
} from '@/lib/exporter'
import type { SequenceRenderer } from '@/lib/renderer'
import type { MediaPool } from '@/lib/media-pool'
import type { AudioOptions } from '@/lib/audio-engine'
import type { AspectRatio, Clip } from '@/types/project'
import type { VoiceoverBlock } from '@/types/voiceover'

interface Props {
  clips: Clip[]
  blocks: VoiceoverBlock[]
  renderer: SequenceRenderer
  pool: MediaPool
  audioOpts: AudioOptions
  aspect: AspectRatio
  durationMs: number
  /** Timeline instants of the recorded clicks, for the synthesised click track. */
  clickTimesMs: number[]
  /** Pauses playback: decoding for preview and for export at once starves both. */
  onBeforeExport: () => void
}

const PHASE_LABEL: Record<ExportProgress['phase'], string> = {
  audio: 'Mixage audio',
  video: 'Rendu des images',
  encoding: 'Encodage final',
  done: 'Terminé',
}

export default function ExportPanel({
  clips,
  blocks,
  renderer,
  pool,
  audioOpts,
  aspect,
  durationMs,
  clickTimesMs,
  onBeforeExport,
}: Props) {
  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const signalRef = useRef<{ cancelled: boolean }>({ cancelled: false })

  const busy = progress !== null && progress.phase !== 'done'

  const start = useCallback(async () => {
    setError(null)
    setResult(null)

    const suffix = aspect === '9:16' ? 'short' : 'paysage'
    const outputPath = await window.screenflow.pickExportPath(
      `screenflow-${suffix}-${Date.now().toString(36)}.mp4`,
    )
    if (!outputPath) return

    onBeforeExport()
    signalRef.current = { cancelled: false }
    setProgress({ phase: 'audio', ratio: 0 })

    try {
      const path = await runExport({
        clips,
        blocks,
        renderer,
        pool,
        audioOpts,
        exportOpts: opts,
        aspect,
        durationMs,
        clickTimesMs,
        outputPath,
        onProgress: setProgress,
        signal: signalRef.current,
      })
      setResult(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }, [
    clips,
    blocks,
    renderer,
    pool,
    audioOpts,
    opts,
    aspect,
    durationMs,
    clickTimesMs,
    onBeforeExport,
  ])

  const totalFrames = Math.max(1, Math.floor((durationMs / 1000) * opts.fps))

  return (
    <div className="space-y-5">
      <Slider
        label="Images par seconde"
        value={opts.fps}
        min={24}
        max={60}
        step={1}
        format={(v) => `${v} fps`}
        onChange={(fps) => setOpts((o) => ({ ...o, fps }))}
      />
      <label className="block">
        <span className="text-xs text-neutral-400">Résolution</span>
        <select
          value={opts.height}
          disabled={busy}
          onChange={(e) => setOpts((o) => ({ ...o, height: Number(e.target.value) }))}
          className="mt-2 w-full rounded border border-edge bg-surface px-2 py-1.5 text-xs text-neutral-300"
        >
          <option value={720}>720p</option>
          <option value={1080}>1080p</option>
          <option value={1440}>1440p</option>
          <option value={2160}>2160p (source si inférieure)</option>
        </select>
      </label>
      <Slider
        label="Qualité (CRF)"
        value={opts.crf}
        min={14}
        max={28}
        step={1}
        format={(v) => (v <= 18 ? `${v} (haute)` : v <= 23 ? `${v} (bonne)` : `${v} (légère)`)}
        onChange={(crf) => setOpts((o) => ({ ...o, crf }))}
      />

      <p className="rounded border border-edge bg-surface px-3 py-2 text-[11px] leading-relaxed text-neutral-500">
        {totalFrames} images à rendre. Chaque image est décodée par un seek exact, donc
        l'export est nettement plus lent que la lecture — compte plusieurs minutes pour
        une longue capture.
      </p>

      {busy && progress && (
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-neutral-300">{PHASE_LABEL[progress.phase]}</span>
            <span className="text-xs tabular-nums text-neutral-500">
              {progress.frame != null
                ? `${progress.frame}/${progress.totalFrames}`
                : `${Math.round(progress.ratio * 100)} %`}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded bg-surface">
            <div
              className="h-full bg-indigo-500 transition-[width]"
              style={{ width: `${progress.ratio * 100}%` }}
            />
          </div>
        </div>
      )}

      {busy ? (
        <button
          onClick={() => {
            signalRef.current.cancelled = true
          }}
          className="btn-ghost w-full text-xs"
        >
          Annuler
        </button>
      ) : (
        <button onClick={start} className="btn-primary w-full text-xs">
          Exporter en MP4
        </button>
      )}

      {error && (
        <p className="whitespace-pre-wrap rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          {error}
        </p>
      )}

      {result && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          <p className="text-[11px] text-emerald-300">Export terminé.</p>
          <button
            onClick={() => window.screenflow.reveal(result)}
            className="btn-ghost mt-2 w-full text-xs"
          >
            Afficher le fichier
          </button>
        </div>
      )}
    </div>
  )
}
