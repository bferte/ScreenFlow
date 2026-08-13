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

/** Length of the synthesised sample. Long enough for the body to ring out. */
const DURATION_MS = 90

/**
 * Builds the click waveform.
 *
 * Three layers, which is what makes it read as a *mechanical* click rather than
 * a beep: a noise transient for the impact, a short high tick for the switch,
 * and a low body that decays slowly enough to be felt. Deliberately fatter and
 * longer than a real mouse — it has to survive next to a voiceover and speaker
 * playback.
 *
 * Takes any BaseAudioContext, so the preview and the exported mix synthesise
 * from the exact same code at the same sample rate.
 */
export function renderClickBuffer(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate
  const length = Math.max(1, Math.ceil((DURATION_MS / 1000) * rate))
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
    const impact = noise() * Math.exp(-t / 0.0012)
    const tick = Math.sin(2 * Math.PI * 2600 * t) * Math.exp(-t / 0.006) * 0.5
    // Slight downward sweep: a fixed pitch sounds like a note, a falling one
    // sounds like something being struck.
    const body = Math.sin(2 * Math.PI * (620 - 180 * t * 10) * t) * Math.exp(-t / 0.028) * 0.55
    const value = impact + tick + body
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

  enabled = false
  /** Linear gain, matching the exported mix's `clickVolume`. */
  volume = 1

  /** A jump larger than this is a seek, not playback: re-aim, do not fire. */
  private static readonly SEEK_MS = 250

  setTimes(times: number[]) {
    this.times = times
    this.lastMs = null
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

  /** Plays one click on demand, for auditioning the level. */
  preview() {
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
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.buffer = renderClickBuffer(this.ctx)
    }
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
