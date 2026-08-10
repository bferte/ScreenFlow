import { useState } from 'react'
import Slider from './Slider'
import type { AvatarConfig, AvatarCorner, AvatarShape } from '@/lib/avatar'

interface Props {
  config: AvatarConfig
  setConfig: React.Dispatch<React.SetStateAction<AvatarConfig>>
  hasCues: boolean
}

const CORNERS: { value: AvatarCorner; label: string }[] = [
  { value: 'top-left', label: '↖' },
  { value: 'top-right', label: '↗' },
  { value: 'bottom-left', label: '↙' },
  { value: 'bottom-right', label: '↘' },
]

export default function AvatarPanel({ config, setConfig, hasCues }: Props) {
  const [error, setError] = useState<string | null>(null)

  async function pickImage() {
    setError(null)
    try {
      const files = await window.screenflow.importMedia()
      const file = files[0]
      if (!file) return
      setConfig((c) => ({ ...c, imagePath: file.path, enabled: true }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-5">
      <label className="flex cursor-pointer items-center justify-between">
        <span className="text-xs text-neutral-400">Afficher l'avatar</span>
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
          className="accent-indigo-500"
        />
      </label>

      <div>
        <button onClick={pickImage} className="btn-ghost w-full text-[11px]">
          {config.imagePath ? 'Changer l\'image' : 'Choisir une image'}
        </button>
        {config.imagePath && (
          <p className="mt-1.5 truncate text-[10px] text-neutral-500" title={config.imagePath}>
            {config.imagePath.split(/[\\/]/).pop()}
          </p>
        )}
        {!config.imagePath && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-500">
            N'importe quelle image (png, jpg). Elle sera recadrée en « couvrant » la forme,
            donc un portrait carré rend le mieux.
          </p>
        )}
      </div>

      {error && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
          {error}
        </p>
      )}

      <div>
        <span className="label">Position</span>
        <div className="mt-2 grid grid-cols-4 gap-1">
          {CORNERS.map((c) => (
            <button
              key={c.value}
              onClick={() => setConfig((p) => ({ ...p, corner: c.value }))}
              className={`rounded border py-2 text-sm transition-colors ${
                config.corner === c.value
                  ? 'border-indigo-500 bg-indigo-500/15 text-indigo-100'
                  : 'border-edge bg-surface text-neutral-400 hover:border-neutral-600'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="label">Forme</span>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(
            [
              ['circle', 'Cercle'],
              ['rounded', 'Arrondi'],
            ] as [AvatarShape, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setConfig((c) => ({ ...c, shape: value }))}
              className={`rounded border px-2 py-1.5 text-[11px] transition-colors ${
                config.shape === value
                  ? 'border-indigo-500 bg-indigo-500/15 text-indigo-100'
                  : 'border-edge bg-surface text-neutral-400 hover:border-neutral-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <Slider
        label="Taille"
        value={config.sizePct}
        min={0.08}
        max={0.45}
        step={0.01}
        format={(v) => `${(v * 100).toFixed(0)} % de la hauteur`}
        onChange={(sizePct) => setConfig((c) => ({ ...c, sizePct }))}
      />
      <Slider
        label="Marge"
        value={config.marginPct}
        min={0}
        max={0.12}
        step={0.005}
        format={(v) => `${(v * 100).toFixed(1)} %`}
        onChange={(marginPct) => setConfig((c) => ({ ...c, marginPct }))}
      />
      <Slider
        label="Épaisseur du contour"
        value={config.borderWidth}
        min={0}
        max={16}
        step={1}
        format={(v) => (v === 0 ? 'aucun' : `${v} px`)}
        onChange={(borderWidth) => setConfig((c) => ({ ...c, borderWidth }))}
      />
      <label className="flex items-center justify-between">
        <span className="text-xs text-neutral-400">Couleur du contour</span>
        <input
          type="color"
          value={config.borderColor}
          onChange={(e) => setConfig((c) => ({ ...c, borderColor: e.target.value }))}
          className="h-7 w-12 cursor-pointer rounded border border-edge bg-surface"
        />
      </label>

      <hr className="border-edge" />

      <label className="flex cursor-pointer items-center justify-between">
        <span className="text-xs text-neutral-400">Uniquement quand la voix parle</span>
        <input
          type="checkbox"
          checked={config.onlyWhileSpeaking}
          disabled={!hasCues}
          onChange={(e) => setConfig((c) => ({ ...c, onlyWhileSpeaking: e.target.checked }))}
          className="accent-indigo-500 disabled:opacity-40"
        />
      </label>
      {!hasCues && (
        <p className="-mt-3 text-[10px] text-neutral-600">
          Nécessite au moins une réplique de voix-off générée.
        </p>
      )}

      <p className="rounded border border-edge bg-surface px-2.5 py-2 text-[10px] leading-relaxed text-neutral-500">
        L'image fixe peut être remplacée plus tard par une séquence animée synchronisée sur
        la voix-off : <code>AvatarSource.imageAt(t)</code> prend déjà un timestamp, donc le
        compositeur n'aura pas à changer.
      </p>
    </div>
  )
}
