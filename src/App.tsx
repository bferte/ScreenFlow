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
          <Library recordings={recordings} onEdit={setEditing} onChanged={refresh} />
        )}
      </div>
    </div>
  )
}

function Library({
  recordings,
  onEdit,
  onChanged,
}: {
  recordings: RecordingManifest[]
  onEdit: (m: RecordingManifest) => void
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  if (recordings.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-neutral-600">Aucun enregistrement pour l'instant.</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      {error && (
        <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-3 rounded border border-edge bg-surface px-3 py-2 text-xs text-neutral-400">
          {notice}
        </p>
      )}
      <div className="grid gap-3">
        {recordings.map((r) => (
          <LibraryRow
            key={r.id}
            recording={r}
            onEdit={() => onEdit(r)}
            onChanged={onChanged}
            onError={setError}
            onNotice={setNotice}
          />
        ))}
      </div>
    </div>
  )
}

/** The date a capture was made, which is its name until it is given one. */
function fallbackName(r: RecordingManifest) {
  return new Date(r.createdAt).toLocaleString('fr-FR')
}

function LibraryRow({
  recording: r,
  onEdit,
  onChanged,
  onError,
  onNotice,
}: {
  recording: RecordingManifest
  onEdit: () => void
  onChanged: () => void
  onError: (message: string | null) => void
  onNotice: (message: string | null) => void
}) {
  const [editingName, setEditingName] = useState(false)
  const [draft, setDraft] = useState(r.name ?? '')
  // Deleting a capture cannot be undone from here, so the button asks first
  // rather than firing a native dialog that would interrupt the whole window.
  const [confirming, setConfirming] = useState(false)

  const commit = async () => {
    setEditingName(false)
    if (draft.trim() === (r.name ?? '')) return
    try {
      onError(null)
      await window.screenflow.renameRecording(r.id, draft)
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async () => {
    try {
      onError(null)
      const { trashed } = await window.screenflow.deleteRecording(r.id)
      onNotice(
        trashed
          ? `« ${r.name || fallbackName(r)} » déplacé vers la corbeille.`
          : `« ${r.name || fallbackName(r)} » supprimé définitivement (pas de corbeille disponible).`,
      )
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="panel flex items-center gap-4 px-5 py-4">
      <div className="min-w-0 flex-1">
        {editingName ? (
          <input
            autoFocus
            value={draft}
            placeholder={fallbackName(r)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit()
              if (e.key === 'Escape') {
                setDraft(r.name ?? '')
                setEditingName(false)
              }
            }}
            className="w-full rounded border border-edge bg-surface px-2 py-1 text-sm text-neutral-100 outline-none focus:border-indigo-500"
          />
        ) : (
          <button
            onClick={() => {
              setDraft(r.name ?? '')
              setEditingName(true)
            }}
            title="Renommer"
            className="block max-w-full truncate text-left text-sm font-medium text-neutral-200 hover:text-indigo-300"
          >
            {r.name || fallbackName(r)}
          </button>
        )}
        <p className="mt-1 text-xs text-neutral-500">
          {r.name && `${fallbackName(r)} · `}
          {(r.duration / 1000).toFixed(1)} s · {r.micPath ? 'micro' : 'sans micro'} ·{' '}
          {r.systemAudioPath ? 'son système' : 'sans son système'}
        </p>
      </div>

      <button onClick={() => window.screenflow.reveal(r.videoPath)} className="btn-ghost">
        Ouvrir le dossier
      </button>

      {confirming ? (
        <>
          <button
            onClick={remove}
            className="rounded-md border border-red-500/50 bg-red-500/15 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/25"
          >
            Confirmer
          </button>
          <button onClick={() => setConfirming(false)} className="btn-ghost">
            Annuler
          </button>
        </>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          title="Supprimer cette capture"
          className="btn-ghost text-neutral-500 hover:text-red-300"
        >
          Supprimer
        </button>
      )}

      <button onClick={onEdit} className="btn-primary">
        Monter
      </button>
    </div>
  )
}
