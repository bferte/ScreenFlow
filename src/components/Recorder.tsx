import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ScreenRecorder, type RecorderWarnings } from '@/lib/recorder'
import type { CaptureSource } from '../../electron/preload'
import type { DisplayInfo, RecordingManifest } from '@/types/telemetry'

type Phase = 'idle' | 'recording' | 'saving'

function formatClock(ms: number) {
  const total = Math.floor(ms / 1000)
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

interface Props {
  onRecorded: (manifest: RecordingManifest) => void
}

export default function Recorder({ onRecorded }: Props) {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [display, setDisplay] = useState<DisplayInfo | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [warnings, setWarnings] = useState<RecorderWarnings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [captureMic, setCaptureMic] = useState(true)
  const [captureSystemAudio, setCaptureSystemAudio] = useState(true)
  const [fps, setFps] = useState(60)

  const recorderRef = useRef<ScreenRecorder | null>(null)
  const previewRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([window.screenflow.listSources(), window.screenflow.primaryDisplay()])
      .then(([list, primary]) => {
        if (cancelled) return
        setSources(list)
        setDisplay(primary)
        setSelectedId((current) => current ?? list.find((s) => s.kind === 'screen')?.id ?? null)
      })
      .catch((e: unknown) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [])

  // Wall-clock timer; the authoritative duration comes from the telemetry file.
  useEffect(() => {
    if (phase !== 'recording') return
    const startedAt = Date.now()
    setElapsed(0)
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 250)
    return () => clearInterval(id)
  }, [phase])

  const selected = useMemo(
    () => sources.find((s) => s.id === selectedId) ?? null,
    [sources, selectedId],
  )

  async function handleStart() {
    if (!selected || !display) return
    setError(null)
    setWarnings(null)

    const recorder = new ScreenRecorder()
    recorderRef.current = recorder

    try {
      const result = await recorder.start({
        sourceId: selected.id,
        displayId: selected.displayId ?? display.id,
        width: display.pixelWidth,
        height: display.pixelHeight,
        fps,
        captureMic,
        captureSystemAudio,
      })
      setWarnings(result)
      setPhase('recording')

      if (previewRef.current && recorder.previewStream) {
        previewRef.current.srcObject = recorder.previewStream
        void previewRef.current.play()
      }
    } catch (e) {
      recorderRef.current = null
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleStop() {
    const recorder = recorderRef.current
    if (!recorder) return
    setPhase('saving')
    try {
      const manifest = await recorder.stop()
      onRecorded(manifest)
      setPhase('idle')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle')
    } finally {
      recorderRef.current = null
      if (previewRef.current) previewRef.current.srcObject = null
    }
  }

  const activeWarnings = warnings
    ? ([warnings.systemAudio, warnings.mic, warnings.clicks].filter(Boolean) as string[])
    : []

  return (
    <div className="flex h-full">
      {/* Source picker */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-edge bg-panel">
        <div className="border-b border-edge px-5 py-4">
          <h2 className="text-sm font-semibold text-neutral-200">Source de capture</h2>
          <p className="mt-1 text-xs text-neutral-500">
            {display
              ? `Écran principal ${display.pixelWidth}×${display.pixelHeight}`
              : 'Détection…'}
          </p>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {sources.map((source) => (
            <button
              key={source.id}
              onClick={() => phase === 'idle' && setSelectedId(source.id)}
              disabled={phase !== 'idle'}
              className={`w-full overflow-hidden rounded-lg border text-left transition-colors ${
                selectedId === source.id
                  ? 'border-indigo-500 bg-indigo-500/10'
                  : 'border-edge bg-surface hover:border-neutral-600'
              } disabled:opacity-50`}
            >
              <img src={source.thumbnail} alt="" className="aspect-video w-full object-cover" />
              <div className="px-3 py-2">
                <p className="truncate text-xs font-medium text-neutral-300">{source.name}</p>
                <p className="text-[10px] uppercase tracking-wide text-neutral-600">
                  {source.kind === 'screen' ? 'Écran' : 'Fenêtre'}
                </p>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Stage */}
      <main className="flex flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center bg-black/40 p-8">
          {phase === 'recording' ? (
            <video
              ref={previewRef}
              muted
              playsInline
              className="max-h-full max-w-full rounded-lg border border-edge shadow-2xl"
            />
          ) : selected ? (
            <img
              src={selected.thumbnail}
              alt=""
              className="max-h-full max-w-full rounded-lg border border-edge opacity-60 shadow-2xl"
            />
          ) : (
            <p className="text-sm text-neutral-600">Sélectionne une source à gauche.</p>
          )}
        </div>

        {/* Controls */}
        <div className="border-t border-edge bg-panel px-6 py-5">
          <div className="flex items-center gap-6">
            {phase === 'recording' ? (
              <button onClick={handleStop} className="btn-danger">
                <span className="h-2.5 w-2.5 rounded-sm bg-white" />
                Arrêter · {formatClock(elapsed)}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={!selected || phase === 'saving'}
                className="btn-primary"
              >
                <span className="h-2.5 w-2.5 rounded-full bg-white" />
                {phase === 'saving' ? 'Enregistrement…' : 'Démarrer la capture'}
              </button>
            )}

            <div className="flex items-center gap-5 text-sm">
              <label className="flex items-center gap-2 text-neutral-400">
                <input
                  type="checkbox"
                  checked={captureMic}
                  disabled={phase !== 'idle'}
                  onChange={(e) => setCaptureMic(e.target.checked)}
                  className="accent-indigo-500"
                />
                Micro
              </label>
              <label className="flex items-center gap-2 text-neutral-400">
                <input
                  type="checkbox"
                  checked={captureSystemAudio}
                  disabled={phase !== 'idle'}
                  onChange={(e) => setCaptureSystemAudio(e.target.checked)}
                  className="accent-indigo-500"
                />
                Son système
              </label>
              <label className="flex items-center gap-2 text-neutral-400">
                <select
                  value={fps}
                  disabled={phase !== 'idle'}
                  onChange={(e) => setFps(Number(e.target.value))}
                  className="rounded border border-edge bg-surface px-2 py-1 text-neutral-300"
                >
                  <option value={30}>30 fps</option>
                  <option value={60}>60 fps</option>
                </select>
              </label>
            </div>
          </div>

          <AnimatePresence>
            {(activeWarnings.length > 0 || error) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-4 space-y-2 overflow-hidden"
              >
                {error && (
                  <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {error}
                  </p>
                )}
                {activeWarnings.map((w) => (
                  <p
                    key={w}
                    className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
                  >
                    {w}
                  </p>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  )
}
