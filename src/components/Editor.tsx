import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SequencePlayer, { type SequencePlayerHandle } from './SequencePlayer'
import Timeline, { type TimelineClick, type TimelineSegment } from './Timeline'
import Slider from './Slider'
import ClipsPanel, { nextClipId } from './ClipsPanel'
import ExportPanel from './ExportPanel'
import {
  DEFAULT_ZOOM_OPTIONS,
  ZoomTrack,
  generateSegments,
  type TrackFraming,
  type ZoomOptions,
} from '@/lib/zoom-engine'
import {
  DEFAULT_ANNOTATION_OPTIONS,
  createOverlayRenderer,
  type AnnotationOptions,
  type SpotlightWindow,
} from '@/lib/overlays'
import { AudioEngine, DEFAULT_AUDIO_OPTIONS, type AudioOptions } from '@/lib/audio-engine'
import { VoiceoverEngine } from '@/lib/voiceover-engine'
import { buildTimelineEnvelope } from '@/lib/speech-sources'
import { DuckingEnvelope } from '@/lib/ducking'
import VoicePanel from './VoicePanel'
import AvatarPanel from './AvatarPanel'
import { DEFAULT_AVATAR_CONFIG, StaticAvatar, type AvatarConfig, type AvatarSource } from '@/lib/avatar'
import { blockCovers, type VoiceoverBlock } from '@/types/voiceover'
import { Sequence } from '@/lib/sequence'
import { MediaPool } from '@/lib/media-pool'
import { SequenceRenderer, outputSize, type ClipRuntime } from '@/lib/renderer'
import type { AspectRatio, Clip, FramingMode } from '@/types/project'
import type { RecordingManifest, Telemetry } from '@/types/telemetry'

type Tab = 'clips' | 'format' | 'zoom' | 'annotations' | 'audio' | 'voice' | 'avatar' | 'export'

interface Props {
  manifest: RecordingManifest
  onBack: () => void
}

/** Preview height; the export panel picks its own. */
const PREVIEW_HEIGHT = 720

export default function Editor({ manifest, onBack }: Props) {
  const [clips, setClips] = useState<Clip[]>(() => [
    { kind: 'recording', id: `rec-${manifest.id}`, manifest, inMs: 0, outMs: manifest.duration, volume: 1 },
  ])
  const [telemetries, setTelemetries] = useState<Map<string, Telemetry>>(new Map())
  const [error, setError] = useState<string | null>(null)

  const [aspect, setAspect] = useState<AspectRatio>('16:9')
  const [framingMode, setFramingMode] = useState<FramingMode>('crop')
  const [followCursor, setFollowCursor] = useState(true)

  const [zoomOpts, setZoomOpts] = useState<ZoomOptions>(DEFAULT_ZOOM_OPTIONS)
  const [annOpts, setAnnOpts] = useState<AnnotationOptions>(DEFAULT_ANNOTATION_OPTIONS)
  const [audioOpts, setAudioOpts] = useState<AudioOptions>(DEFAULT_AUDIO_OPTIONS)

  const [currentMs, setCurrentMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('clips')
  const [duckGain, setDuckGain] = useState(1)

  const [blocks, setBlocks] = useState<VoiceoverBlock[]>([])
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [envelope, setEnvelope] = useState<DuckingEnvelope | null>(null)
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(DEFAULT_AVATAR_CONFIG)
  const [avatarSource, setAvatarSource] = useState<AvatarSource | null>(null)

  const playerRef = useRef<SequencePlayerHandle | null>(null)
  const audioEnginesRef = useRef<Map<string, AudioEngine>>(new Map())
  const voiceRef = useRef<VoiceoverEngine>(new VoiceoverEngine())

  /* ---------------------------------------------------------------- *
   * Telemetry, one per recording clip
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const missing = clips.filter(
      (c) => c.kind === 'recording' && !telemetries.has(c.manifest.telemetryPath),
    )
    if (missing.length === 0) return

    let cancelled = false
    Promise.all(
      missing.map(async (c) => {
        const p = (c as Extract<Clip, { kind: 'recording' }>).manifest.telemetryPath
        return [p, await window.screenflow.readTelemetry(p)] as const
      }),
    )
      .then((loaded) => {
        if (cancelled) return
        setTelemetries((prev) => {
          const next = new Map(prev)
          for (const [p, t] of loaded) next.set(p, t)
          return next
        })
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))

    return () => {
      cancelled = true
    }
  }, [clips, telemetries])

  /* ---------------------------------------------------------------- *
   * Derived model
   * ---------------------------------------------------------------- */

  const sequence = useMemo(() => new Sequence(clips), [clips])
  const durationMs = sequence.durationMs

  const outSize = useMemo(() => outputSize(aspect, PREVIEW_HEIGHT), [aspect])
  const outAspect = outSize.width / outSize.height

  /**
   * Which media exist and in what order — deliberately excluding volume and
   * trim. Those change on every slider tick, and keying the pool or the zoom
   * tracks on the whole clip array would reload every video element and
   * re-integrate every spring while the user drags.
   */
  const clipIdentity = useMemo(
    () =>
      clips
        .map((c) => `${c.id}:${c.kind === 'recording' ? c.manifest.videoPath : c.path}`)
        .join('|'),
    [clips],
  )

  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  /**
   * The pool is built by the effect, not by a memo, and that is not a stylistic
   * choice.
   *
   * StrictMode runs setup → cleanup → setup on mount. The cleanup disposes the
   * pool, which empties it — and a memoised pool is *not* rebuilt when the
   * effect runs again, so every later `get()` returns null and the preview
   * stays black. Only in development: a production build mounts once, which is
   * exactly why this survived. Owning the pool from inside the effect means a
   * cleanup is always followed by a fresh one.
   *
   * The initial pool is empty on purpose — it holds no element and fetches
   * nothing, so the effect's pool is the only one that ever loads media.
   */
  const [pool, setPool] = useState(() => new MediaPool([]))
  useEffect(() => {
    const next = new MediaPool(clipsRef.current)
    setPool((previous) => {
      previous.dispose()
      return next
    })
    return () => next.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipIdentity])

  // Clip volume is applied per frame in `handleFrame`, where the ducking gain
  // is also known — setting it here as well would just fight that.

  const runtimes = useMemo(() => {
    const map = new Map<string, ClipRuntime>()

    // Read through the ref: this memo intentionally does not re-run on volume
    // or trim edits, so closing over a stale `clips` would be a real hazard.
    for (const clip of clipsRef.current) {
      if (clip.kind === 'media') {
        map.set(clip.id, {
          track: null,
          sourceWidth: clip.width ?? outSize.width,
          sourceHeight: clip.height ?? outSize.height,
          hasVideo: clip.hasVideo,
        })
        continue
      }

      const telemetry = telemetries.get(clip.manifest.telemetryPath)
      if (!telemetry) continue

      const sourceWidth = telemetry.display.pixelWidth
      const sourceHeight = telemetry.display.pixelHeight
      const framing: TrackFraming = {
        sourceAspect: sourceWidth / sourceHeight,
        outAspect,
        // Auto-framing only earns its keep when the output crops the source.
        followCursor: followCursor && framingMode === 'crop' && outAspect < sourceWidth / sourceHeight,
      }

      const segments = generateSegments(telemetry.clicks, zoomOpts)
      const track = new ZoomTrack(
        clip.manifest.duration,
        segments,
        zoomOpts,
        framing,
        telemetry.cursor,
      )
      const windows: SpotlightWindow[] = segments.map((s) => ({
        startT: s.startT,
        endT: s.endT,
        nx: s.nx,
        ny: s.ny,
      }))

      map.set(clip.id, {
        track,
        overlay: createOverlayRenderer(telemetry, windows, annOpts),
        sourceWidth,
        sourceHeight,
        hasVideo: true,
      })
    }
    return map
    // Keyed on clip identity, not the clip objects: volume and trim edits must
    // not trigger a full spring re-integration on every slider tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipIdentity, telemetries, zoomOpts, annOpts, outAspect, followCursor, framingMode, outSize])

  useEffect(() => {
    if (!avatarConfig.imagePath) {
      setAvatarSource(null)
      return
    }
    const source = new StaticAvatar(window.screenflow.mediaUrl(avatarConfig.imagePath))
    setAvatarSource(source)
    return () => source.dispose()
  }, [avatarConfig.imagePath])

  /** Whether any voiceover block covers this instant, for the avatar's gating. */
  const isSpeaking = useCallback(
    (tMs: number) => blocks.some((b) => blockCovers(b, tMs)),
    [blocks],
  )

  const renderer = useMemo(
    () =>
      new SequenceRenderer(sequence, runtimes, framingMode, {
        avatar: { config: avatarConfig, source: avatarSource, isSpeaking },
      }),
    [sequence, runtimes, framingMode, avatarConfig, avatarSource, isSpeaking],
  )

  /** Zoom segments and clicks lifted from clip-local time onto the timeline. */
  const { timelineSegments, timelineClicks } = useMemo(() => {
    const segs: TimelineSegment[] = []
    const cls: TimelineClick[] = []
    for (const placed of sequence.placed) {
      const { clip, startT } = placed
      if (clip.kind !== 'recording') continue
      const telemetry = telemetries.get(clip.manifest.telemetryPath)
      if (!telemetry) continue
      const offset = startT - clip.inMs
      for (const s of generateSegments(telemetry.clicks, zoomOpts)) {
        segs.push({ ...s, clipId: clip.id, startT: s.startT + offset, endT: s.endT + offset })
      }
      for (const c of telemetry.clicks) {
        cls.push({ ...c, timelineT: c.t + offset })
      }
    }
    return { timelineSegments: segs, timelineClicks: cls }
  }, [sequence, telemetries, zoomOpts])

  /* ---------------------------------------------------------------- *
   * Audio engines, one per recording clip
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const engines = audioEnginesRef.current
    let disposed = false

    for (const clip of clips) {
      if (clip.kind !== 'recording' || engines.has(clip.id)) continue
      const engine = new AudioEngine()
      engines.set(clip.id, engine)
      const { micPath, systemAudioPath } = clip.manifest
      engine
        .load(
          micPath ? window.screenflow.mediaUrl(micPath) : null,
          systemAudioPath ? window.screenflow.mediaUrl(systemAudioPath) : null,
          DEFAULT_AUDIO_OPTIONS,
        )
        .catch(() => {
          if (!disposed) engines.delete(clip.id)
        })
    }

    // Drop engines whose clip has gone.
    for (const [id, engine] of engines) {
      if (!clips.some((c) => c.id === id)) {
        engine.dispose()
        engines.delete(id)
      }
    }

    return () => {
      disposed = true
    }
  }, [clips])

  useEffect(() => {
    const engines = audioEnginesRef.current
    return () => {
      for (const engine of engines.values()) engine.dispose()
      engines.clear()
    }
  }, [])

  useEffect(() => {
    for (const engine of audioEnginesRef.current.values()) engine.setOptions(audioOpts)
  }, [audioOpts])

  /* ---------------------------------------------------------------- *
   * Voiceover and the timeline-wide ducking curve
   * ---------------------------------------------------------------- */

  useEffect(() => {
    voiceRef.current.reconcile(blocks)
  }, [blocks])

  useEffect(() => {
    const engine = voiceRef.current
    return () => engine.dispose()
  }, [])

  useEffect(() => {
    voiceRef.current.volume = audioOpts.voiceVolume
  }, [audioOpts.voiceVolume])

  /**
   * Only what actually shapes the ducking curve: which audio, where, how long.
   * Volume changes and text edits awaiting regeneration must not trigger a
   * full re-decode of every speech track.
   */
  const blockKey = useMemo(
    () =>
      blocks
        .map((b) => `${b.id}:${b.audioPath}:${b.timelineOffsetMs}:${b.durationMs}`)
        .join('|'),
    [blocks],
  )

  useEffect(() => {
    let cancelled = false
    const duckOpts = {
      duckAmount: audioOpts.duckAmount,
      duckThresholdDb: audioOpts.duckThresholdDb,
      duckAttackMs: audioOpts.duckAttackMs,
      duckReleaseMs: audioOpts.duckReleaseMs,
      duckHoldMs: audioOpts.duckHoldMs,
    }
    buildTimelineEnvelope(clipsRef.current, blocksRef.current, durationMs, duckOpts, audioOpts.ducking)
      .then(({ envelope: env }) => !cancelled && setEnvelope(env))
      .catch(() => !cancelled && setEnvelope(null))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clipIdentity,
    blockKey,
    durationMs,
    audioOpts.ducking,
    audioOpts.duckAmount,
    audioOpts.duckThresholdDb,
    audioOpts.duckAttackMs,
    audioOpts.duckReleaseMs,
    audioOpts.duckHoldMs,
  ])

  const handleFrame = useCallback(
    (timelineMs: number, localMs: number, clipId: string | null) => {
      const isPlaying = !(playerRef.current?.paused ?? true)
      const gain = envelope && audioOpts.ducking ? envelope.sample(timelineMs) : 1

      for (const [id, engine] of audioEnginesRef.current) {
        engine.sync(localMs, isPlaying, id === clipId, gain)
      }
      voiceRef.current.sync(timelineMs, isPlaying)

      // Imported clips carry their own soundtrack, so a jingle must duck under
      // the voiceover exactly like captured system audio does.
      for (const clip of clipsRef.current) {
        if (clip.kind === 'media') pool.setVolume(clip.id, clip.volume * gain)
      }
    },
    [envelope, audioOpts.ducking, pool],
  )

  useEffect(() => {
    setDuckGain(envelope && audioOpts.ducking ? envelope.sample(currentMs) : 1)
  }, [currentMs, envelope, audioOpts.ducking])

  /* ---------------------------------------------------------------- *
   * Transport
   * ---------------------------------------------------------------- */

  const handleSeek = useCallback((ms: number) => {
    playerRef.current?.seek(ms)
    setCurrentMs(ms)
  }, [])

  /**
   * Cuts the clip under the playhead in two.
   *
   * This is what makes inserting a jingle *inside* a capture possible: the
   * halves are two clips over the same source with complementary in/out
   * points, and a media clip can then be dropped between them. Both halves
   * keep the same telemetry, and since `resolve` returns source time the zoom
   * track needs no adjustment at all.
   */
  const MIN_PIECE_MS = 200

  const splitInfo = useMemo(() => {
    const resolved = sequence.resolve(currentMs)
    if (!resolved) return null
    const { placed, localMs } = resolved
    const left = localMs - placed.clip.inMs
    const right = placed.clip.outMs - localMs
    if (left < MIN_PIECE_MS || right < MIN_PIECE_MS) return null
    return { clipId: placed.clip.id, localMs }
  }, [sequence, currentMs])

  const splitAtPlayhead = useCallback(() => {
    if (!splitInfo) return
    const { clipId, localMs } = splitInfo
    setClips((prev) =>
      prev.flatMap((c) => {
        if (c.id !== clipId) return [c]
        // Rebuilt per branch rather than spread over the union, so the
        // discriminant survives and each half stays a well-formed Clip.
        if (c.kind === 'recording') {
          return [
            { ...c, id: nextClipId(), outMs: localMs },
            { ...c, id: nextClipId(), inMs: localMs },
          ]
        }
        return [
          { ...c, id: nextClipId(), outMs: localMs },
          { ...c, id: nextClipId(), inMs: localMs },
        ]
      }),
    )
  }, [splitInfo])

  /**
   * The only mutation a drag performs.
   *
   * Nothing here touches `audioPath`, `text` or `voiceId`, which is what makes
   * moving a block structurally incapable of costing a TTS call — the audio is
   * already on disk and stays bound to the block.
   */
  const moveBlock = useCallback((id: string, timelineOffsetMs: number) => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === id ? { ...b, timelineOffsetMs } : b)),
    )
  }, [])

  const togglePlay = useCallback(() => {
    const p = playerRef.current
    if (!p) return
    if (p.paused) p.play()
    else p.pause()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay])

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    )
  }

  const recordingCount = clips.filter((c) => c.kind === 'recording').length
  const telemetryReady = clips.every(
    (c) => c.kind !== 'recording' || telemetries.has(c.manifest.telemetryPath),
  )

  if (!telemetryReady) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-neutral-600">Chargement de la télémétrie…</p>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-edge px-6 py-3">
          <button onClick={onBack} className="btn-ghost !px-3 !py-1.5 text-xs">
            ← Bibliothèque
          </button>
          <span className="text-xs text-neutral-500">
            {clips.length} clip(s) · {recordingCount} capture(s) · {aspect} ·{' '}
            {outSize.width}×{outSize.height}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center bg-black/40 p-6">
          <SequencePlayer
            ref={playerRef}
            renderer={renderer}
            pool={pool}
            outWidth={outSize.width}
            outHeight={outSize.height}
            onTimeUpdate={setCurrentMs}
            onPlayStateChange={setPlaying}
            onFrame={handleFrame}
          />
        </div>

        <div className="border-t border-edge bg-panel">
          <div className="flex items-center gap-4 px-6 pt-4">
            <button onClick={togglePlay} className="btn-primary !px-3">
              {playing ? '❚❚' : '▶'}
            </button>
            <span className="text-sm tabular-nums text-neutral-400">
              {(currentMs / 1000).toFixed(2)}s / {(durationMs / 1000).toFixed(2)}s
            </span>
            <span className="text-xs text-neutral-600">
              {timelineSegments.length} zoom(s) ·{' '}
              {timelineClicks.filter((c) => c.pressed).length} clic(s)
            </span>
          </div>
          <Timeline
            durationMs={durationMs}
            currentMs={currentMs}
            clicks={timelineClicks}
            segments={timelineSegments}
            placed={sequence.placed}
            blocks={blocks}
            onSeek={handleSeek}
            selectedId={selectedId}
            onSelect={setSelectedId}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            selectedBlockId={selectedBlockId}
            onSelectBlock={setSelectedBlockId}
            onMoveBlock={moveBlock}
          />
        </div>
      </main>

      <aside className="flex w-72 shrink-0 flex-col border-l border-edge bg-panel">
        <div className="flex flex-wrap border-b border-edge">
          {(
            [
              ['clips', 'Clips'],
              ['format', 'Format'],
              ['zoom', 'Zoom'],
              ['annotations', 'Annot.'],
              ['audio', 'Audio'],
              ['voice', 'Voix'],
              ['avatar', 'Avatar'],
              ['export', 'Export'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 basis-1/3 px-1 py-2 text-[11px] transition-colors ${
                tab === id
                  ? 'border-b-2 border-indigo-500 text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'clips' && (
            <ClipsPanel
              clips={clips}
              setClips={setClips}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onSplit={splitAtPlayhead}
              canSplit={splitInfo !== null}
            />
          )}
          {tab === 'format' && (
            <FormatPanel
              aspect={aspect}
              setAspect={setAspect}
              mode={framingMode}
              setMode={setFramingMode}
              followCursor={followCursor}
              setFollowCursor={setFollowCursor}
            />
          )}
          {tab === 'zoom' && <ZoomPanel opts={zoomOpts} setOpts={setZoomOpts} />}
          {tab === 'annotations' && <AnnotationPanel opts={annOpts} setOpts={setAnnOpts} />}
          {tab === 'audio' && (
            <AudioPanel
              opts={audioOpts}
              setOpts={setAudioOpts}
              hasMic={clips.some((c) => c.kind === 'recording' && !!c.manifest.micPath)}
              hasSystem={clips.some((c) => c.kind === 'recording' && !!c.manifest.systemAudioPath)}
              duckGain={duckGain}
            />
          )}
          {tab === 'voice' && (
            <VoicePanel
              blocks={blocks}
              setBlocks={setBlocks}
              currentMs={currentMs}
              durationMs={durationMs}
              voiceVolume={audioOpts.voiceVolume}
              setVoiceVolume={(voiceVolume) => setAudioOpts((o) => ({ ...o, voiceVolume }))}
              onSeek={handleSeek}
              selectedBlockId={selectedBlockId}
              onSelectBlock={setSelectedBlockId}
            />
          )}
          {tab === 'avatar' && (
            <AvatarPanel
              config={avatarConfig}
              setConfig={setAvatarConfig}
              hasCues={blocks.length > 0}
            />
          )}
          {tab === 'export' && (
            <ExportPanel
              clips={clips}
              blocks={blocks}
              renderer={renderer}
              pool={pool}
              audioOpts={audioOpts}
              aspect={aspect}
              durationMs={durationMs}
              onBeforeExport={() => playerRef.current?.pause()}
            />
          )}
        </div>
      </aside>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

function FormatPanel({
  aspect,
  setAspect,
  mode,
  setMode,
  followCursor,
  setFollowCursor,
}: {
  aspect: AspectRatio
  setAspect: (a: AspectRatio) => void
  mode: FramingMode
  setMode: (m: FramingMode) => void
  followCursor: boolean
  setFollowCursor: (v: boolean) => void
}) {
  return (
    <div className="space-y-5">
      <div>
        <span className="label">Ratio</span>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(
            [
              ['16:9', 'Paysage'],
              ['9:16', 'Shorts'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setAspect(value)}
              className={`rounded border px-2 py-2 text-[11px] transition-colors ${
                aspect === value
                  ? 'border-indigo-500 bg-indigo-500/15 text-indigo-100'
                  : 'border-edge bg-surface text-neutral-400 hover:border-neutral-600'
              }`}
            >
              <div className="font-medium">{value}</div>
              <div className="text-[10px] text-neutral-500">{label}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="label">Habillage</span>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as FramingMode)}
          className="mt-2 w-full rounded border border-edge bg-surface px-2 py-1.5 text-xs text-neutral-300"
        >
          <option value="crop">Recadrage (plein cadre)</option>
          <option value="fit-blur">Entier + fond flou</option>
          <option value="fit-gradient">Entier + dégradé</option>
        </select>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
          {mode === 'crop'
            ? 'Une tranche de la capture remplit tout le cadre. En 9:16 seule ~32 % de la largeur reste visible : le suivi du curseur devient indispensable.'
            : 'La capture entière est conservée, les bandes sont habillées. Rien n’est perdu, mais l’image est plus petite.'}
        </p>
      </div>

      {mode === 'crop' && aspect === '9:16' && (
        <Toggle label="Suivre le curseur" checked={followCursor} onChange={setFollowCursor} />
      )}
    </div>
  )
}

function ZoomPanel({
  opts,
  setOpts,
}: {
  opts: ZoomOptions
  setOpts: React.Dispatch<React.SetStateAction<ZoomOptions>>
}) {
  return (
    <div className="space-y-5">
      <Slider label="Facteur" value={opts.scale} min={1.2} max={4} step={0.1}
        format={(v) => `×${v.toFixed(1)}`} onChange={(scale) => setOpts((o) => ({ ...o, scale }))} />
      <Slider label="Anticipation" value={opts.leadMs} min={0} max={1000} step={20}
        format={(v) => `${Math.round(v)} ms`} onChange={(leadMs) => setOpts((o) => ({ ...o, leadMs }))} />
      <Slider label="Maintien après clic" value={opts.holdMs} min={200} max={3000} step={50}
        format={(v) => `${Math.round(v)} ms`} onChange={(holdMs) => setOpts((o) => ({ ...o, holdMs }))} />
      <Slider label="Réactivité du ressort" value={opts.frequency} min={0.4} max={3} step={0.05}
        format={(v) => `${v.toFixed(2)} Hz`} onChange={(frequency) => setOpts((o) => ({ ...o, frequency }))} />
      <Slider label="Amortissement" value={opts.damping} min={0.5} max={1.2} step={0.05}
        format={(v) => (v >= 1 ? `${v.toFixed(2)} (net)` : `${v.toFixed(2)} (rebond)`)}
        onChange={(damping) => setOpts((o) => ({ ...o, damping }))} />
      <hr className="border-edge" />
      <Slider label="Regroupement des clics" value={opts.clusterGapMs} min={200} max={4000} step={100}
        format={(v) => `${Math.round(v)} ms`} onChange={(clusterGapMs) => setOpts((o) => ({ ...o, clusterGapMs }))} />
      <Slider label="Pontage entre zooms" value={opts.bridgeMs} min={0} max={2000} step={50}
        format={(v) => `${Math.round(v)} ms`} onChange={(bridgeMs) => setOpts((o) => ({ ...o, bridgeMs }))} />
      <button onClick={() => setOpts(DEFAULT_ZOOM_OPTIONS)} className="btn-ghost w-full text-xs">
        Réinitialiser
      </button>
    </div>
  )
}

function AnnotationPanel({
  opts,
  setOpts,
}: {
  opts: AnnotationOptions
  setOpts: React.Dispatch<React.SetStateAction<AnnotationOptions>>
}) {
  return (
    <div className="space-y-5">
      <Toggle label="Cercles de clic" checked={opts.rings}
        onChange={(rings) => setOpts((o) => ({ ...o, rings }))} />
      {opts.rings && (
        <>
          <Slider label="Durée" value={opts.ringDurationMs} min={200} max={1500} step={20}
            format={(v) => `${Math.round(v)} ms`}
            onChange={(ringDurationMs) => setOpts((o) => ({ ...o, ringDurationMs }))} />
          <Slider label="Rayon" value={opts.ringRadius} min={0.02} max={0.15} step={0.005}
            format={(v) => `${(v * 100).toFixed(1)} %`}
            onChange={(ringRadius) => setOpts((o) => ({ ...o, ringRadius }))} />
          <label className="flex items-center justify-between">
            <span className="text-xs text-neutral-400">Couleur</span>
            <input type="color" value={opts.ringColor}
              onChange={(e) => setOpts((o) => ({ ...o, ringColor: e.target.value }))}
              className="h-7 w-12 cursor-pointer rounded border border-edge bg-surface" />
          </label>
        </>
      )}
      <hr className="border-edge" />
      <Toggle label="Spotlight" checked={opts.spotlight}
        onChange={(spotlight) => setOpts((o) => ({ ...o, spotlight }))} />
      {opts.spotlight && (
        <>
          <Slider label="Rayon éclairé" value={opts.spotlightRadius} min={0.08} max={0.5} step={0.01}
            format={(v) => `${(v * 100).toFixed(0)} %`}
            onChange={(spotlightRadius) => setOpts((o) => ({ ...o, spotlightRadius }))} />
          <Slider label="Assombrissement" value={opts.spotlightDarkness} min={0.1} max={0.95} step={0.05}
            format={(v) => `${(v * 100).toFixed(0)} %`}
            onChange={(spotlightDarkness) => setOpts((o) => ({ ...o, spotlightDarkness }))} />
          <Toggle label="Suit le curseur" checked={opts.spotlightFollowsCursor}
            onChange={(spotlightFollowsCursor) => setOpts((o) => ({ ...o, spotlightFollowsCursor }))} />
        </>
      )}
      <button onClick={() => setOpts(DEFAULT_ANNOTATION_OPTIONS)} className="btn-ghost w-full text-xs">
        Réinitialiser
      </button>
    </div>
  )
}

function AudioPanel({
  opts,
  setOpts,
  hasMic,
  hasSystem,
  duckGain,
}: {
  opts: AudioOptions
  setOpts: React.Dispatch<React.SetStateAction<AudioOptions>>
  hasMic: boolean
  hasSystem: boolean
  duckGain: number
}) {
  return (
    <div className="space-y-5">
      {!hasMic && !hasSystem && (
        <p className="rounded border border-edge bg-surface px-3 py-2 text-xs text-neutral-500">
          Aucune capture avec piste audio dans ce projet.
        </p>
      )}
      {hasMic && (
        <Slider label="Volume micro" value={opts.micVolume} min={0} max={2} step={0.05}
          format={(v) => `${Math.round(v * 100)} %`}
          onChange={(micVolume) => setOpts((o) => ({ ...o, micVolume }))} />
      )}
      {hasSystem && (
        <Slider label="Volume système" value={opts.systemVolume} min={0} max={2} step={0.05}
          format={(v) => `${Math.round(v * 100)} %`}
          onChange={(systemVolume) => setOpts((o) => ({ ...o, systemVolume }))} />
      )}
      {hasMic && hasSystem && (
        <>
          <hr className="border-edge" />
          <Toggle label="Ducking automatique" checked={opts.ducking}
            onChange={(ducking) => setOpts((o) => ({ ...o, ducking }))} />
          {opts.ducking && (
            <>
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-neutral-400">Atténuation en cours</span>
                  <span className="text-xs tabular-nums text-neutral-500">
                    {(duckGain * 100).toFixed(0)} %
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-surface">
                  <div className="h-full bg-indigo-500 transition-[width] duration-100"
                    style={{ width: `${duckGain * 100}%` }} />
                </div>
              </div>
              <Slider label="Force" value={opts.duckAmount} min={0.1} max={0.95} step={0.05}
                format={(v) => `−${Math.round(v * 100)} %`}
                onChange={(duckAmount) => setOpts((o) => ({ ...o, duckAmount }))} />
              <Slider label="Seuil de voix" value={opts.duckThresholdDb} min={-70} max={-15} step={1}
                format={(v) => `${v} dB`}
                onChange={(duckThresholdDb) => setOpts((o) => ({ ...o, duckThresholdDb }))} />
              <Slider label="Attaque" value={opts.duckAttackMs} min={20} max={600} step={10}
                format={(v) => `${Math.round(v)} ms`}
                onChange={(duckAttackMs) => setOpts((o) => ({ ...o, duckAttackMs }))} />
              <Slider label="Retour" value={opts.duckReleaseMs} min={80} max={1500} step={20}
                format={(v) => `${Math.round(v)} ms`}
                onChange={(duckReleaseMs) => setOpts((o) => ({ ...o, duckReleaseMs }))} />
            </>
          )}
        </>
      )}
      <button onClick={() => setOpts(DEFAULT_AUDIO_OPTIONS)} className="btn-ghost w-full text-xs">
        Réinitialiser
      </button>
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between">
      <span className="text-xs text-neutral-400">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="accent-indigo-500" />
    </label>
  )
}
