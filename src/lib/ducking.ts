export interface DuckingOptions {
  /** Fraction the ducked tracks drop by while a voice is present, 0..1. */
  duckAmount: number
  /** Level above which speech is considered present, in dBFS. */
  duckThresholdDb: number
  duckAttackMs: number
  duckReleaseMs: number
  /** Keep ducking this long after the voice stops, so gaps between words
   *  do not make the other tracks pump back up. */
  duckHoldMs: number
}

/** A speech track placed somewhere on the timeline. */
export interface SpeechSource {
  buffer: AudioBuffer
  /** Timeline position of the source's in-point, in ms. */
  offsetMs: number
  /** Trim inside the buffer. */
  inMs: number
  durationMs: number
}

/** Resolution of the precomputed ducking curve. */
const ENVELOPE_HZ = 100

/**
 * A precomputed gain curve, in timeline time.
 *
 * Timeline-wide rather than per-clip because a voiceover cue belongs to the
 * timeline, not to any one clip: it can start over a jingle and finish over a
 * capture. Every speech track — each recording's mic, every generated cue — is
 * folded into a single curve here.
 *
 * Analysing levels live during playback would make the result depend on when
 * playback started and would be impossible to reproduce offline, so the export
 * would not match what was previewed. Computing the whole curve up front makes
 * `sample(t)` a pure lookup the renderer and the exporter can share.
 */
export class DuckingEnvelope {
  private constructor(
    private readonly gains: Float32Array,
    readonly durationMs: number,
  ) {}

  get hz() {
    return ENVELOPE_HZ
  }

  /** A flat curve, for when nothing is speaking or ducking is off. */
  static silent(durationMs: number): DuckingEnvelope {
    const steps = Math.max(1, Math.ceil((durationMs / 1000) * ENVELOPE_HZ) + 1)
    return new DuckingEnvelope(new Float32Array(steps).fill(1), durationMs)
  }

  static fromSources(
    sources: SpeechSource[],
    timelineDurationMs: number,
    opts: DuckingOptions,
  ): DuckingEnvelope {
    const stepSec = 1 / ENVELOPE_HZ
    const steps = Math.max(1, Math.ceil((timelineDurationMs / 1000) * ENVELOPE_HZ) + 1)
    if (sources.length === 0) return DuckingEnvelope.silent(timelineDurationMs)

    const threshold = Math.pow(10, opts.duckThresholdDb / 20)

    // First pass: is any source speaking at this step? Sources overlap freely,
    // so presence is a union rather than a sum.
    const speaking = new Uint8Array(steps)

    for (const source of sources) {
      const { buffer, offsetMs, inMs, durationMs } = source
      const windowSize = Math.max(1, Math.floor(buffer.sampleRate * stepSec))
      const channels: Float32Array[] = []
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))

      const localSteps = Math.ceil((durationMs / 1000) * ENVELOPE_HZ)
      const inSteps = Math.floor((inMs / 1000) * ENVELOPE_HZ)
      const baseStep = Math.round((offsetMs / 1000) * ENVELOPE_HZ)

      for (let i = 0; i < localSteps; i++) {
        const timelineStep = baseStep + i
        if (timelineStep < 0 || timelineStep >= steps) continue
        if (speaking[timelineStep]) continue

        const start = (inSteps + i) * windowSize
        let sumSquares = 0
        let count = 0
        for (const data of channels) {
          const end = Math.min(data.length, start + windowSize)
          for (let s = start; s < end; s++) {
            sumSquares += data[s] * data[s]
            count++
          }
        }
        const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0
        if (rms >= threshold) speaking[timelineStep] = 1
      }
    }

    // Second pass: turn presence into a smooth gain with hold, fast attack and
    // slow release.
    const attackCoef = 1 - Math.exp(-stepSec / Math.max(0.001, opts.duckAttackMs / 1000))
    const releaseCoef = 1 - Math.exp(-stepSec / Math.max(0.001, opts.duckReleaseMs / 1000))
    const holdSteps = Math.round((opts.duckHoldMs / 1000) * ENVELOPE_HZ)
    const floor = 1 - opts.duckAmount

    const gains = new Float32Array(steps)
    let gain = 1
    let holdCounter = 0

    for (let i = 0; i < steps; i++) {
      if (speaking[i]) holdCounter = holdSteps
      else if (holdCounter > 0) holdCounter--

      const target = speaking[i] || holdCounter > 0 ? floor : 1
      // Ducking must clamp down fast and recover slowly, so the coefficient
      // depends on which direction we are moving.
      const coef = target < gain ? attackCoef : releaseCoef
      gain += (target - gain) * coef
      gains[i] = gain
    }

    return new DuckingEnvelope(gains, timelineDurationMs)
  }

  sample(tMs: number): number {
    const last = this.gains.length - 1
    const pos = Math.min(last, Math.max(0, (tMs / 1000) * ENVELOPE_HZ))
    const i = Math.floor(pos)
    const j = Math.min(last, i + 1)
    return this.gains[i] + (this.gains[j] - this.gains[i]) * (pos - i)
  }

  /** Exposed so the exporter can replay the same curve as gain automation. */
  toArray(): Float32Array {
    return this.gains
  }
}
