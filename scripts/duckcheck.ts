/**
 * Validates the timeline-wide ducking envelope without a browser.
 *
 * DuckingEnvelope only needs four things from an AudioBuffer, so a stub backed
 * by raw PCM exercises the real DSP path.
 *
 * Run: npx esbuild scripts/duckcheck.ts --bundle --platform=node --format=cjs \
 *        --alias:@=./src --outfile=x.cjs && node x.cjs [mic.raw]
 */
import { readFileSync } from 'node:fs'
import { DuckingEnvelope, type DuckingOptions, type SpeechSource } from '../src/lib/ducking'

const SR = 48000

const OPTS: DuckingOptions = {
  duckAmount: 0.75,
  duckThresholdDb: -42,
  duckAttackMs: 120,
  duckReleaseMs: 420,
  duckHoldMs: 260,
}
const FLOOR = 1 - OPTS.duckAmount

let failures = 0
function near(label: string, actual: number, expected: number, tol: number) {
  const ok = Math.abs(actual - expected) <= tol
  if (!ok) failures++
  console.log(
    `  ${ok ? 'OK  ' : 'ECHEC'} ${label}  ->  ${actual.toFixed(3)}${ok ? '' : ` (attendu ~${expected.toFixed(3)})`}`,
  )
}

function stub(channel: Float32Array, sampleRate = SR): AudioBuffer {
  return {
    numberOfChannels: 1,
    sampleRate,
    length: channel.length,
    duration: channel.length / sampleRate,
    getChannelData: () => channel,
  } as unknown as AudioBuffer
}

const dbToLinear = (db: number) => Math.pow(10, db / 20)

/** Speech-shaped tone between the given seconds, silence elsewhere. */
function tone(totalSec: number, spans: [number, number][]): Float32Array {
  const out = new Float32Array(Math.ceil(totalSec * SR))
  const amp = dbToLinear(-20)
  for (const [from, to] of spans) {
    for (let i = Math.floor(from * SR); i < Math.floor(to * SR); i++) {
      out[i] =
        amp *
        Math.sin((2 * Math.PI * 200 * i) / SR) *
        (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / SR))
    }
  }
  return out
}

const src = (buffer: AudioBuffer, offsetMs: number, durationMs: number): SpeechSource => ({
  buffer,
  offsetMs,
  inMs: 0,
  durationMs,
})

console.log(`parametres: plancher ${FLOOR.toFixed(2)}, seuil ${OPTS.duckThresholdDb}dB`)
console.log(`            attaque ${OPTS.duckAttackMs}ms, retour ${OPTS.duckReleaseMs}ms, maintien ${OPTS.duckHoldMs}ms`)

/* ------------------------------------------------------------------ */
console.log('\n=== SOURCE UNIQUE (non-regression) ===')

// silence -> speech -> short gap -> speech -> long silence
const single = DuckingEnvelope.fromSources(
  [src(stub(tone(6, [[1.0, 2.5], [3.0, 4.0]])), 0, 6000)],
  6000,
  OPTS,
)
near('avant toute voix (0.5s)', single.sample(500), 1, 0.01)
near('voix etablie (1.6s)', single.sample(1600), FLOOR, 0.02)
near('trou court, maintien tient (2.65s)', single.sample(2650), FLOOR, 0.03)
near('2e segment (3.6s)', single.sample(3600), FLOOR, 0.02)
near('apres retour (5.5s)', single.sample(5500), 1, 0.05)

/* ------------------------------------------------------------------ */
console.log('\n=== DEUX SOURCES DECALEES (micro + voix-off) ===')

// Mic speaks early; a generated cue speaks later, elsewhere on the timeline.
const mic = stub(tone(10, [[0.5, 1.5]]))
const cue = stub(tone(2, [[0.0, 2.0]]))

const two = DuckingEnvelope.fromSources(
  [src(mic, 0, 10000), src(cue, 6000, 2000)],
  10000,
  OPTS,
)
near('micro parle (1.0s)', two.sample(1000), FLOOR, 0.03)
near('personne ne parle (4.0s)', two.sample(4000), 1, 0.03)
near('voix-off parle (6.8s)', two.sample(6800), FLOOR, 0.03)
near('apres la voix-off (9.5s)', two.sample(9500), 1, 0.05)

console.log('\n  -- la voix-off decalee doit bien agir a sa place, pas a t=0 --')
const onlyCue = DuckingEnvelope.fromSources([src(cue, 6000, 2000)], 10000, OPTS)
near('avant la cue (2.0s)', onlyCue.sample(2000), 1, 0.01)
near('pendant la cue (6.8s)', onlyCue.sample(6800), FLOOR, 0.03)

/* ------------------------------------------------------------------ */
console.log('\n=== RECOUVREMENT : union, pas double attenuation ===')

const a = stub(tone(4, [[0.0, 3.0]]))
const b = stub(tone(4, [[1.0, 4.0]]))
const overlap = DuckingEnvelope.fromSources([src(a, 0, 4000), src(b, 0, 4000)], 4000, OPTS)

let min = Infinity
for (let ms = 0; ms <= 4000; ms += 10) min = Math.min(min, overlap.sample(ms))
near('plancher jamais depasse pendant le recouvrement', min, FLOOR, 0.005)

/* ------------------------------------------------------------------ */
console.log('\n=== BORNES ===')
let gMin = Infinity
let gMax = -Infinity
for (let ms = 0; ms <= 10000; ms += 10) {
  const g = two.sample(ms)
  gMin = Math.min(gMin, g)
  gMax = Math.max(gMax, g)
}
console.log(`  gain min/max : ${gMin.toFixed(3)} .. ${gMax.toFixed(3)}`)
const inBounds = gMin >= FLOOR - 1e-6 && gMax <= 1 + 1e-6
if (!inBounds) failures++
console.log(`  ${inBounds ? 'OK  ' : 'ECHEC'} dans [${FLOOR.toFixed(2)}, 1.00]`)

const silent = DuckingEnvelope.silent(5000)
near('courbe neutre a 1.0', silent.sample(2500), 1, 1e-9)
const empty = DuckingEnvelope.fromSources([], 5000, OPTS)
near('aucune source -> pas d attenuation', empty.sample(2500), 1, 1e-9)

/* ------------------------------------------------------------------ */
const rawPath = process.argv[2]
if (rawPath) {
  const buf = readFileSync(rawPath)
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
  let peak = 0
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]))
  const durationMs = (pcm.length / SR) * 1000
  const env = DuckingEnvelope.fromSources([src(stub(pcm), 0, durationMs)], durationMs, OPTS)

  let ducked = 0
  const steps = Math.floor(durationMs / 10)
  for (let i = 0; i < steps; i++) if (env.sample(i * 10) < 0.99) ducked++

  console.log('\n=== MICRO REEL ===')
  console.log(`  duree : ${(durationMs / 1000).toFixed(2)} s, crete ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS`)
  console.log(`  pas attenues : ${ducked}/${steps}`)
  if (ducked !== 0) failures++
  console.log(`  ${ducked === 0 ? 'OK  ' : 'ECHEC'} aucun faux positif sur piste muette`)
}

console.log(`\n=== ${failures === 0 ? 'TOUT PASSE' : `${failures} ECHEC(S)`} ===`)
process.exit(failures === 0 ? 0 : 1)
