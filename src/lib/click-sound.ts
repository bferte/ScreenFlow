import { clipDuration } from '@/types/project'
import type { Telemetry } from '@/types/telemetry'
import type { PlacedClip } from './sequence'

/**
 * A synthesised click, played over the capture at each recorded click.
 *
 * Screen recordings are silent about the one thing a demo viewer most needs to
 * follow: when something was actually pressed. The telemetry already knows, so
 * the sound is *derived* from it like every other edit here — no asset file, no
 * library, and nothing to keep in sync with the video.
 */

/**
 * One component of a sound.
 *
 * Everything here is struck-object modelling rather than melody: an impact is
 * noise, a switch is a short high tone, and the part you *feel* is a low tone
 * that outlives both. Layering those three, with the right decays, is the
 * difference between a click and a beep.
 */
interface Layer {
  /** Noise for impacts, tone for the switch and the body. */
  kind: 'noise' | 'tone'
  /** Starting frequency, tones only. */
  freq?: number
  /** Hz lost per second. A falling pitch reads as struck; a fixed one as a note. */
  sweep?: number
  /** Exponential decay constant, in seconds. */
  decay: number
  gain: number
  /** Seconds after the start — for a second impact, e.g. a key bottoming out. */
  delay?: number
}

export interface SoundSpec {
  id: string
  /** Shown in the picker. */
  label: string
  /** One line on what it sounds like, so the list is choosable without trying all of it. */
  hint: string
  durationMs: number
  layers: Layer[]
}

/**
 * The palette.
 *
 * Each entry is data, not code: adding a sound is adding layers, and every one
 * of them goes through the same synthesis, normalisation and fade — so they are
 * all consistent with each other and all reproducible bit for bit.
 */
export const CLICK_SOUNDS: SoundSpec[] = [
  {
    id: 'mouse',
    label: 'Clic de souris',
    hint: 'Net et sec, le clic mécanique par défaut.',
    durationMs: 90,
    layers: [
      { kind: 'noise', decay: 0.0012, gain: 1 },
      { kind: 'tone', freq: 2600, decay: 0.006, gain: 0.5 },
      { kind: 'tone', freq: 620, sweep: 1800, decay: 0.028, gain: 0.55 },
    ],
  },
  {
    id: 'soft',
    label: 'Clic doux',
    hint: 'Feutré, sans attaque agressive. Pour une démo posée.',
    durationMs: 70,
    layers: [
      { kind: 'noise', decay: 0.0008, gain: 0.35 },
      { kind: 'tone', freq: 1500, decay: 0.01, gain: 0.3 },
      { kind: 'tone', freq: 420, sweep: 1200, decay: 0.04, gain: 0.6 },
    ],
  },
  {
    id: 'mech-key',
    label: 'Touche mécanique',
    hint: 'Clavier à switches : le clic, puis la butée juste après.',
    durationMs: 130,
    layers: [
      { kind: 'noise', decay: 0.001, gain: 0.8 },
      { kind: 'tone', freq: 1800, decay: 0.005, gain: 0.45 },
      { kind: 'tone', freq: 260, sweep: 900, decay: 0.03, gain: 0.5 },
      // The bottom-out, 20 ms later: what makes a mechanical key sound like
      // travel rather than a single contact.
      { kind: 'noise', decay: 0.0015, gain: 0.6, delay: 0.02 },
      { kind: 'tone', freq: 180, sweep: 600, decay: 0.045, gain: 0.7, delay: 0.02 },
    ],
  },
  {
    id: 'laptop-key',
    label: 'Touche de portable',
    hint: 'Chiclet mat et court, presque sans résonance.',
    durationMs: 55,
    layers: [
      { kind: 'noise', decay: 0.0009, gain: 0.5 },
      { kind: 'tone', freq: 900, decay: 0.004, gain: 0.25 },
      { kind: 'tone', freq: 300, sweep: 900, decay: 0.018, gain: 0.7 },
    ],
  },
  {
    id: 'typewriter',
    label: 'Machine à écrire',
    hint: 'Frappe métallique appuyée, très présente.',
    durationMs: 160,
    layers: [
      { kind: 'noise', decay: 0.002, gain: 1 },
      { kind: 'tone', freq: 3200, decay: 0.008, gain: 0.6 },
      { kind: 'tone', freq: 1400, decay: 0.02, gain: 0.35 },
      { kind: 'tone', freq: 210, sweep: 500, decay: 0.06, gain: 0.55 },
    ],
  },
  {
    id: 'pop',
    label: 'Pop',
    hint: 'Bulle synthétique, aucun bruit. Discret et moderne.',
    durationMs: 120,
    layers: [{ kind: 'tone', freq: 900, sweep: 5200, decay: 0.035, gain: 1 }],
  },
]

export const DEFAULT_CLICK_SOUND = CLICK_SOUNDS[0].id

/**
 * Builds a sound's waveform.
 *
 * Takes any BaseAudioContext, so the preview and the exported mix synthesise
 * from the exact same code at the same sample rate.
 */
export function renderClickBuffer(ctx: BaseAudioContext, soundId = DEFAULT_CLICK_SOUND): AudioBuffer {
  const spec = CLICK_SOUNDS.find((s) => s.id === soundId) ?? CLICK_SOUNDS[0]
  const rate = ctx.sampleRate
  const length = Math.max(1, Math.ceil((spec.durationMs / 1000) * rate))
  const buffer = ctx.createBuffer(1, length, rate)
  const data = buffer.getChannelData(0)

  // Deterministic noise. Math.random would give the preview and the export
  // each their own waveform, and "the export matches what was auditioned" is
  // the one property this whole pipeline is built around.
  let seed = 0x9e3779b9
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x80000000 - 1
  }

  let peak = 0
  for (let i = 0; i < length; i++) {
    const t = i / rate
    let value = 0
    for (const layer of spec.layers) {
      // Every layer consumes the generator at every sample, delayed or not, so
      // a layer's noise never depends on when another one starts.
      const sample = layer.kind === 'noise' ? noise() : 0
      const age = t - (layer.delay ?? 0)
      if (age < 0) continue
      const envelope = Math.exp(-age / layer.decay) * layer.gain
      value +=
        layer.kind === 'noise'
          ? sample * envelope
          : Math.sin(2 * Math.PI * ((layer.freq ?? 0) - (layer.sweep ?? 0) * age) * age) * envelope
    }
    data[i] = value
    peak = Math.max(peak, Math.abs(value))
  }

  // Normalise, then fade the tail so the sample itself does not end on a step —
  // which would add a click to the click.
  const fade = Math.min(length, Math.ceil(0.004 * rate))
  const scale = peak > 0 ? 0.9 / peak : 1
  for (let i = 0; i < length; i++) {
    // Counted from the last sample, so the ramp reaches exactly zero there.
    const remaining = length - 1 - i
    data[i] *= scale * (remaining < fade ? remaining / fade : 1)
  }

  return buffer
}

/**
 * Timeline instants, in ms, at which a click sound should fire.
 *
 * Only presses count — a release is not what the viewer needs to hear. Clicks
 * outside what the trim keeps are dropped: they belong to a moment the edit
 * cut away, and playing them would announce something never shown.
 */
export function collectClickTimes(
  placed: PlacedClip[],
  telemetries: Map<string, Telemetry>,
): number[] {
  const times: number[] = []
  for (const p of placed) {
    const { clip } = p
    if (clip.kind !== 'recording') continue
    const telemetry = telemetries.get(clip.manifest.telemetryPath)
    if (!telemetry) continue

    const kept = clipDuration(clip)
    for (const click of telemetry.clicks) {
      if (!click.pressed) continue
      const local = click.t - clip.inMs
      if (local < 0 || local > kept) continue
      times.push(p.startT + local)
    }
  }
  return times.sort((a, b) => a - b)
}

/**
 * Fires click sounds as the playhead crosses them.
 *
 * The timeline clock drives this, not a scheduler: the player can be paused,
 * seeked or dragged at any moment, and a queue of pre-scheduled sources would
 * keep firing into a timeline that has moved. Crossing detection costs one
 * comparison per frame and can never fire for a spot the playhead did not
 * actually pass.
 */
export class ClickTrack {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private times: number[] = []
  private next = 0
  private lastMs: number | null = null

  private soundId = DEFAULT_CLICK_SOUND

  enabled = false
  /** Linear gain, matching the exported mix's `clickVolume`. */
  volume = 1

  /** A jump larger than this is a seek, not playback: re-aim, do not fire. */
  private static readonly SEEK_MS = 250

  setTimes(times: number[]) {
    this.times = times
    this.lastMs = null
  }

  /** Switching sound drops the cached buffer; the next one played rebuilds it. */
  setSound(soundId: string) {
    if (soundId === this.soundId) return
    this.soundId = soundId
    this.buffer = null
  }

  /** Called every frame with the timeline clock. `duckGain` matches the mix. */
  sync(timelineMs: number, playing: boolean, duckGain = 1) {
    if (!playing || !this.enabled) {
      // Forget where we were, so resuming re-aims instead of firing every
      // click the playhead was moved across while paused.
      this.lastMs = null
      return
    }

    const previous = this.lastMs
    this.lastMs = timelineMs

    if (previous === null || timelineMs < previous || timelineMs - previous > ClickTrack.SEEK_MS) {
      this.next = this.times.findIndex((t) => t > timelineMs)
      if (this.next < 0) this.next = this.times.length
      return
    }

    while (this.next < this.times.length && this.times[this.next] <= timelineMs) {
      this.fire(duckGain)
      this.next++
    }
  }

  /** Plays one click on demand, for auditioning a sound or a level. */
  preview(soundId?: string) {
    if (soundId) this.setSound(soundId)
    this.fire(1)
  }

  private fire(duckGain: number) {
    const ctx = this.context()
    if (!ctx || !this.buffer) return
    const source = ctx.createBufferSource()
    source.buffer = this.buffer
    const gain = ctx.createGain()
    gain.gain.value = Math.max(0, this.volume * duckGain)
    source.connect(gain).connect(ctx.destination)
    source.start()
  }

  private context(): AudioContext | null {
    if (!this.ctx) this.ctx = new AudioContext()
    if (!this.buffer) this.buffer = renderClickBuffer(this.ctx, this.soundId)
    // Autoplay policy can leave the context suspended until a gesture; playback
    // always starts from one, so resuming here is enough.
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  dispose() {
    void this.ctx?.close()
    this.ctx = null
    this.buffer = null
  }
}
