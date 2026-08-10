import { useCallback, useEffect, useState } from 'react'
import Recorder from '@/components/Recorder'
import Editor from '@/components/Editor'
import type { RecordingManifest } from '@/types/telemetry'

type View = 'capture' | 'library'

export default function App() {
  const [view, setView] = useState<View>('capture')
  const [recordings, setRecordings] = useState<RecordingManifest[]>([])
  const [editing, setEditing] = useState<RecordingManifest | null>(null)

  const refresh = useCallback(() => {
    window.screenflow.listRecordings().then(setRecordings).catch(() => setRecordings([]))
  }, [])

  useEffect(refresh, [refresh])

  const handleRecorded = useCallback(
    (manifest: RecordingManifest) => {
      setRecordings((prev) => [manifest, ...prev])
      setView('library')
    },
    [],
  )

  if (editing) {
    return <Editor manifest={editing} onBack={() => setEditing(null)} />
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-6 border-b border-edge bg-panel px-6 py-3">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-gradient-to-br from-indigo-400 to-fuchsia-500" />
          <span className="text-sm font-semibold tracking-tight text-neutral-100">ScreenFlow</span>
        </div>

        <nav className="flex gap-1">
          {(['capture', 'library'] as const).map((v) => (
            <button
              key={v}
              onClick={() => v === 'library' ? (refresh(), setView(v)) : setView(v)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                view === v
                  ? 'bg-surface text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {v === 'capture' ? 'Capture' : `Bibliothèque (${recordings.length})`}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1">
        {view === 'capture' ? (
          <Recorder onRecorded={handleRecorded} />
        ) : (
          <Library recordings={recordings} onEdit={setEditing} />
        )}
      </div>
    </div>
  )
}

function Library({
  recordings,
  onEdit,
}: {
  recordings: RecordingManifest[]
  onEdit: (m: RecordingManifest) => void
}) {
  if (recordings.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-neutral-600">Aucun enregistrement pour l'instant.</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="grid gap-3">
        {recordings.map((r) => (
          <div key={r.id} className="panel flex items-center gap-4 px-5 py-4">
            <div className="flex-1">
              <p className="text-sm font-medium text-neutral-200">
                {new Date(r.createdAt).toLocaleString('fr-FR')}
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                {(r.duration / 1000).toFixed(1)} s · {r.micPath ? 'micro' : 'sans micro'} ·{' '}
                {r.systemAudioPath ? 'son système' : 'sans son système'}
              </p>
            </div>
            <button onClick={() => window.screenflow.reveal(r.videoPath)} className="btn-ghost">
              Ouvrir le dossier
            </button>
            <button onClick={() => onEdit(r)} className="btn-primary">
              Monter
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
