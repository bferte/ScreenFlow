import type { DuckingOptions } from './ducking'

export interface AudioOptions extends DuckingOptions {
  /** Linear gain, 0..2. */
  micVolume: number
  systemVolume: number
  voiceVolume: number
  ducking: boolean
  /** Play a synthesised click at each recorded click. Off by default: it adds
   *  a sound the capture never contained, which has to be a deliberate choice. */
  clickSound: boolean
  clickVolume: number
}

export const DEFAULT_AUDIO_OPTIONS: AudioOptions = {
  micVolume: 1,
  systemVolume: 0.8,
  voiceVolume: 1,
  ducking: true,
  clickSound: false,
  clickVolume: 0.8,
  duckAmount: 0.75,
  duckThresholdDb: -42,
  duckAttackMs: 120,
  duckReleaseMs: 420,
  duckHoldMs: 260,
}

/**
 * Plays one recording's separately-captured mic and system tracks.
 *
 * The ducking gain is passed in rather than computed here: the curve is now
 * timeline-wide, because a voiceover cue can speak over a jingle and carry on
 * into a capture. A per-clip engine has no way to know about that.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private micEl: HTMLAudioElement | null = null
  private systemEl: HTMLAudioElement | null = null
  private micGain: GainNode | null = null
  private systemGain: GainNode | null = null

  opts: AudioOptions = DEFAULT_AUDIO_OPTIONS

  /** Resync threshold in seconds; below this, drift is inaudible. */
  private static readonly MAX_DRIFT = 0.08

  hasMic = false
  hasSystem = false

  async load(micUrl: string | null, systemUrl: string | null, opts: AudioOptions) {
    this.opts = opts
    this.ctx = new AudioContext()

    if (micUrl) {
      this.micEl = this.makeElement(micUrl)
      const src = this.ctx.createMediaElementSource(this.micEl)
      this.micGain = this.ctx.createGain()
      src.connect(this.micGain).connect(this.ctx.destination)
      this.hasMic = true
    }

    if (systemUrl) {
      this.systemEl = this.makeElement(systemUrl)
      const src = this.ctx.createMediaElementSource(this.systemEl)
      this.systemGain = this.ctx.createGain()
      src.connect(this.systemGain).connect(this.ctx.destination)
      this.hasSystem = true
    }
  }

  private makeElement(url: string): HTMLAudioElement {
    const el = new Audio()
    // Required before the element is fed into Web Audio, or the graph is
    // tainted and outputs silence with no error raised.
    el.crossOrigin = 'anonymous'
    el.src = url
    el.preload = 'auto'
    el.load()
    return el
  }

  setOptions(next: AudioOptions) {
    this.opts = next
  }

  /**
   * Drives both tracks from the timeline clock.
   *
   * `localMs` is time inside this recording. When `active` is false the clip is
   * not on screen, so its audio stops rather than bleeding over a jingle.
   */
  sync(localMs: number, playing: boolean, active: boolean, duckGain: number) {
    if (this.micGain) this.micGain.gain.value = this.opts.micVolume
    if (this.systemGain) {
      this.systemGain.gain.value =
        this.opts.systemVolume * (this.opts.ducking ? duckGain : 1)
    }

    const shouldPlay = active && playing
    const target = localMs / 1000

    for (const el of [this.micEl, this.systemEl]) {
      if (!el) continue

      if (!active) {
        if (!el.paused) el.pause()
        continue
      }

      if (Math.abs(el.currentTime - target) > AudioEngine.MAX_DRIFT) {
        el.currentTime = target
      }
      if (shouldPlay && el.paused) {
        void this.ctx?.resume()
        void el.play().catch(() => undefined)
      } else if (!shouldPlay && !el.paused) {
        el.pause()
      }
    }
  }

  dispose() {
    for (const el of [this.micEl, this.systemEl]) {
      if (!el) continue
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
    this.micEl = null
    this.systemEl = null
    void this.ctx?.close()
    this.ctx = null
  }
}
