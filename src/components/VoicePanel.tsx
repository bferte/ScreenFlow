import { useCallback, useEffect, useState } from 'react'
import Slider from './Slider'
import {
  DEFAULT_TTS_SETTINGS,
  OPENAI_VOICES,
  blockEndMs,
  type TtsProvider,
  type TtsSettings,
  type VoiceoverBlock,
} from '@/types/voiceover'

interface Props {
  blocks: VoiceoverBlock[]
  setBlocks: React.Dispatch<React.SetStateAction<VoiceoverBlock[]>>
  currentMs: number
  durationMs: number
  voiceVolume: number
  setVoiceVolume: (v: number) => void
  onSeek: (ms: number) => void
  selectedBlockId: string | null
  onSelectBlock: (id: string | null) => void
}

let counter = 0
const nextBlockId = () => `vo-${Date.now().toString(36)}-${counter++}`

export default function VoicePanel({
  blocks,
  setBlocks,
  currentMs,
  durationMs,
  voiceVolume,
  setVoiceVolume,
  onSeek,
  selectedBlockId,
  onSelectBlock,
}: Props) {
  const [settings, setSettings] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  /** Per-block edits not yet regenerated. */
  const [pending, setPending] = useState<Record<string, string>>({})

  useEffect(() => {
    window.screenflow.getSettings().then(setSettings).catch(() => undefined)
  }, [])

  const patch = useCallback(async (p: Record<string, string>) => {
    setSettings((await window.screenflow.setSettings(p)) as TtsSettings)
  }, [])

  async function saveKey() {
    if (!keyDraft.trim()) return
    await patch(
      settings.provider === 'openai'
        ? { openaiKey: keyDraft.trim() }
        : { elevenKey: keyDraft.trim() },
    )
    // Cleared at once: the key lives in the main process and has no reason to
    // linger in renderer state.
    setKeyDraft('')
  }

  const currentVoice =
    settings.provider === 'openai' ? settings.openaiVoice : settings.elevenVoiceId
  const hasKey = settings.provider === 'openai' ? settings.hasOpenaiKey : settings.hasElevenKey

  /** Generates audio and drops a new block at the playhead. */
  async function createBlock() {
    const text = draft.trim()
    if (!text) return
    setBusy('new')
    setError(null)
    try {
      const result = await window.screenflow.speak({
        text,
        provider: settings.provider,
        voice: currentVoice || undefined,
      })
      const block: VoiceoverBlock = {
        id: nextBlockId(),
        text,
        voiceId: currentVoice,
        provider: settings.provider,
        audioPath: result.audioPath,
        durationMs: result.durationMs,
        timelineOffsetMs: Math.round(currentMs),
        volume: 1,
      }
      setBlocks((prev) => [...prev, block])
      onSelectBlock(block.id)
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /** Re-synthesises one block in place, keeping its position and volume. */
  async function regenerate(block: VoiceoverBlock) {
    const text = (pending[block.id] ?? block.text).trim()
    if (!text) return
    setBusy(block.id)
    setError(null)
    try {
      const result = await window.screenflow.speak({
        text,
        provider: block.provider,
        voice: block.voiceId || undefined,
      })
      setBlocks((prev) =>
        prev.map((b) =>
          b.id === block.id
            ? { ...b, text, audioPath: result.audioPath, durationMs: result.durationMs }
            : b,
        ),
      )
      setPending((p) => {
        const next = { ...p }
        delete next[block.id]
        return next
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <Slider
        label="Volume voix-off"
        value={voiceVolume}
        min={0}
        max={2}
        step={0.05}
        format={(v) => `${Math.round(v * 100)} %`}
        onChange={setVoiceVolume}
      />

      {/* Composer */}
      <div className="rounded border border-edge bg-surface p-2.5">
        <span className="label">Nouveau bloc</span>
        <textarea
          value={draft}
          rows={3}
          placeholder="Texte à faire lire…"
          onChange={(e) => setDraft(e.target.value)}
          className="mt-2 w-full resize-none rounded border border-edge bg-panel px-2 py-1.5 text-[11px] text-neutral-200 placeholder:text-neutral-600"
        />
        <button
          onClick={createBlock}
          disabled={busy !== null || !draft.trim() || !hasKey}
          className="btn-primary mt-2 w-full text-[11px]"
        >
          {busy === 'new'
            ? 'Synthèse…'
            : `Générer et poser à ${(currentMs / 1000).toFixed(1)}s`}
        </button>
      </div>

      {!hasKey && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
          Aucune clé {settings.provider === 'openai' ? 'OpenAI' : 'ElevenLabs'} enregistrée.
        </p>
      )}

      {error && (
        <p className="whitespace-pre-wrap rounded border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-[10px] text-red-300">
          {error}
        </p>
      )}

      {/* Blocks */}
      <div className="space-y-2">
        {blocks.length === 0 && (
          <p className="text-[11px] leading-relaxed text-neutral-600">
            Aucun bloc. Une fois généré, un bloc se déplace à la souris sur la piste verte
            de la timeline — sans jamais rappeler l'API.
          </p>
        )}

        {[...blocks]
          .sort((a, b) => a.timelineOffsetMs - b.timelineOffsetMs)
          .map((block) => {
            const edited = pending[block.id] !== undefined && pending[block.id] !== block.text
            return (
              <div
                key={block.id}
                onClick={() => onSelectBlock(block.id)}
                className={`cursor-pointer rounded border p-2.5 transition-colors ${
                  block.id === selectedBlockId
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : 'border-edge bg-surface hover:border-neutral-600'
                }`}
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onSeek(block.timelineOffsetMs)
                    }}
                    className="text-[10px] tabular-nums text-emerald-300 hover:underline"
                  >
                    {(block.timelineOffsetMs / 1000).toFixed(2)}s →{' '}
                    {(blockEndMs(block) / 1000).toFixed(2)}s
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setBlocks((prev) => prev.filter((b) => b.id !== block.id))
                      if (selectedBlockId === block.id) onSelectBlock(null)
                    }}
                    className="ml-auto text-[10px] text-red-400"
                  >
                    ✕
                  </button>
                </div>

                <textarea
                  value={pending[block.id] ?? block.text}
                  rows={2}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    setPending((p) => ({ ...p, [block.id]: e.target.value }))
                  }
                  className="mt-2 w-full resize-none rounded border border-edge bg-panel px-2 py-1.5 text-[11px] text-neutral-200"
                />

                {edited && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void regenerate(block)
                    }}
                    disabled={busy !== null}
                    className="btn-primary mt-1.5 w-full !py-1 text-[10px]"
                  >
                    {busy === block.id ? 'Synthèse…' : 'Régénérer (texte modifié)'}
                  </button>
                )}

                <div onClick={(e) => e.stopPropagation()} className="mt-2">
                  <Slider
                    label="Position"
                    value={Math.min(block.timelineOffsetMs, Math.max(0, durationMs - block.durationMs))}
                    min={0}
                    max={Math.max(0, durationMs - block.durationMs)}
                    step={10}
                    format={(v) => `${(v / 1000).toFixed(2)} s`}
                    onChange={(timelineOffsetMs) =>
                      setBlocks((prev) =>
                        prev.map((b) => (b.id === block.id ? { ...b, timelineOffsetMs } : b)),
                      )
                    }
                  />
                  <div className="mt-2">
                    <Slider
                      label="Volume"
                      value={block.volume}
                      min={0}
                      max={2}
                      step={0.05}
                      format={(v) => `${Math.round(v * 100)} %`}
                      onChange={(volume) =>
                        setBlocks((prev) =>
                          prev.map((b) => (b.id === block.id ? { ...b, volume } : b)),
                        )
                      }
                    />
                  </div>
                </div>

                <p className="mt-1.5 text-[10px] text-neutral-600">
                  {block.provider === 'openai' ? 'OpenAI' : 'ElevenLabs'} · {block.voiceId || '—'}
                </p>
              </div>
            )
          })}
      </div>

      <hr className="border-edge" />

      <button
        onClick={() => setShowSettings((v) => !v)}
        className="w-full text-left text-[11px] text-neutral-400 hover:text-neutral-200"
      >
        {showSettings ? '▾' : '▸'} Paramètres du service
      </button>

      {showSettings && (
        <div className="space-y-3 rounded border border-edge bg-surface p-3">
          <p className="text-[10px] leading-relaxed text-neutral-500">
            Le texte est envoyé au service choisi pour être synthétisé. La clé est stockée
            localement et ne quitte jamais le processus principal. Un texte déjà synthétisé
            est repris depuis le cache disque, sans nouvel appel.
          </p>

          <label className="block">
            <span className="text-[10px] text-neutral-400">Service</span>
            <select
              value={settings.provider}
              onChange={(e) => patch({ provider: e.target.value as TtsProvider })}
              className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-[11px] text-neutral-300"
            >
              <option value="openai">OpenAI</option>
              <option value="elevenlabs">ElevenLabs</option>
            </select>
          </label>

          <label className="block">
            <span className="text-[10px] text-neutral-400">
              Clé API {settings.provider === 'openai' ? 'OpenAI' : 'ElevenLabs'}
              {hasKey && <span className="ml-1 text-emerald-400">(enregistrée)</span>}
            </span>
            <div className="mt-1 flex gap-1">
              <input
                type="password"
                value={keyDraft}
                placeholder={hasKey ? '••••••••  (remplacer)' : 'Coller la clé'}
                onChange={(e) => setKeyDraft(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-edge bg-panel px-2 py-1 text-[11px] text-neutral-300"
              />
              <button
                onClick={saveKey}
                disabled={!keyDraft.trim()}
                className="btn-ghost !px-2 !py-1 text-[10px]"
              >
                OK
              </button>
            </div>
          </label>

          {settings.provider === 'openai' ? (
            <>
              <label className="block">
                <span className="text-[10px] text-neutral-400">Voix</span>
                <select
                  value={settings.openaiVoice}
                  onChange={(e) => patch({ openaiVoice: e.target.value })}
                  className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-[11px] text-neutral-300"
                >
                  {OPENAI_VOICES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] text-neutral-400">Modèle</span>
                <input
                  value={settings.openaiModel}
                  onChange={(e) => patch({ openaiModel: e.target.value })}
                  className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-[11px] text-neutral-300"
                />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="text-[10px] text-neutral-400">Identifiant de voix</span>
                <input
                  value={settings.elevenVoiceId}
                  placeholder="ex. 21m00Tcm4TlvDq8ikWAM"
                  onChange={(e) => patch({ elevenVoiceId: e.target.value })}
                  className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-[11px] text-neutral-300"
                />
              </label>
              <label className="block">
                <span className="text-[10px] text-neutral-400">Modèle</span>
                <input
                  value={settings.elevenModel}
                  onChange={(e) => patch({ elevenModel: e.target.value })}
                  className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-[11px] text-neutral-300"
                />
              </label>
            </>
          )}
        </div>
      )}
    </div>
  )
}
