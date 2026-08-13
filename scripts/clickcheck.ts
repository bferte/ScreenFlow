/**
 * Checks the synthesised click track without an audio device.
 *
 * Two things have to hold for the exported mix to match the preview: the
 * waveform must be identical every time it is synthesised, and a click must
 * only be scheduled for a moment the edit actually keeps.
 *
 * Run: npx esbuild scripts/clickcheck.ts --bundle --platform=node --format=cjs \
 *        --outfile=.check/c.cjs && node .check/c.cjs
 */
import { CLICK_SOUNDS, DEFAULT_CLICK_SOUND, renderClickBuffer, collectClickTimes } from '../src/lib/click-sound'
import type { PlacedClip } from '../src/lib/sequence'
import type { Clip } from '../src/types/project'
import type { ClickEvent, Telemetry } from '../src/types/telemetry'

let failures = 0

function ok(label: string, pass: boolean, detail: string | number = '') {
  console.log(`  ${pass ? 'OK  ' : 'ECHEC'} ${label}${detail === '' ? '' : `  ->  ${detail}`}`)
  if (!pass) failures++
}

/* ------------------------------------------------------------------ *
 * A BaseAudioContext stub: renderClickBuffer only needs these two.
 * ------------------------------------------------------------------ */

function fakeContext(sampleRate: number) {
  return {
    sampleRate,
    createBuffer(channels: number, length: number, rate: number) {
      const data = new Float32Array(length)
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: () => data,
      }
    },
  } as unknown as BaseAudioContext
}

console.log('=== PALETTE ===')

for (const spec of CLICK_SOUNDS) {
  const buffer = renderClickBuffer(fakeContext(48000), spec.id)
  const data = buffer.getChannelData(0)

  let peak = 0
  let peakAt = 0
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > peak) {
      peak = Math.abs(data[i])
      peakAt = i
    }
  }

  // Energy has to be front-loaded, or it reads as a tone rather than an impact.
  const half = Math.floor(data.length / 2)
  let head = 0
  let tail = 0
  for (let i = 0; i < data.length; i++) {
    if (i < half) head += data[i] * data[i]
    else tail += data[i] * data[i]
  }

  const again = renderClickBuffer(fakeContext(48000), spec.id).getChannelData(0)
  let identical = data.length === again.length
  for (let i = 0; identical && i < data.length; i++) identical = data[i] === again[i]

  const pass =
    Math.abs(buffer.duration - spec.durationMs / 1000) < 0.001 &&
    peak > 0.85 &&
    peak <= 0.9001 &&
    // Percussive by construction: the loudest moment is the attack, not
    // somewhere in the middle. A pure tone starts at zero and still passes.
    peakAt < data.length * 0.2 &&
    data[data.length - 1] === 0 &&
    head > tail * 4 &&
    identical

  ok(
    spec.label.padEnd(22),
    pass,
    `${spec.durationMs}ms  crête ${peak.toFixed(3)} à ${((peakAt / 48000) * 1000).toFixed(1)}ms  ` +
      `attaque ${(head / tail).toFixed(1)}x  ${identical ? 'déterministe' : 'NON DETERMINISTE'}`,
  )
}

console.log('\n=== DETAILS ===')

// The mechanical key's second impact is what separates it from a plain click:
// there must be real energy well after the first one has decayed.
const mech = renderClickBuffer(fakeContext(48000), 'mech-key').getChannelData(0)
let beforeBottom = 0
let afterBottom = 0
for (let i = 0; i < mech.length; i++) {
  if (i / 48000 > 0.02 && i / 48000 < 0.05) afterBottom += mech[i] * mech[i]
  if (i / 48000 > 0.012 && i / 48000 < 0.019) beforeBottom += mech[i] * mech[i]
}
ok('touche mécanique : la butée sonne après le clic', afterBottom > beforeBottom * 2,
  (afterBottom / beforeBottom).toFixed(1) + 'x')

// Pop carries no noise layer, so it has to be a clean tone.
const pop = renderClickBuffer(fakeContext(48000), 'pop').getChannelData(0)
let jumps = 0
for (let i = 1; i < pop.length; i++) if (Math.abs(pop[i] - pop[i - 1]) > 0.2) jumps++
ok('pop : aucun bruit, signal lisse', jumps === 0, jumps + ' saut(s)')

const c = renderClickBuffer(fakeContext(44100), DEFAULT_CLICK_SOUND)
ok('suit la fréquence d échantillonnage', c.length === Math.ceil(0.09 * 44100), c.length)

const fallback = renderClickBuffer(fakeContext(48000), 'inconnu').getChannelData(0)
const byDefault = renderClickBuffer(fakeContext(48000), DEFAULT_CLICK_SOUND).getChannelData(0)
let same = fallback.length === byDefault.length
for (let i = 0; same && i < fallback.length; i++) same = fallback[i] === byDefault[i]
ok('un identifiant inconnu retombe sur le son par défaut', same)

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

console.log('\n=== INSTANTS PLANIFIES ===')

function click(t: number, pressed: boolean): ClickEvent {
  return { t, x: 0, y: 0, nx: 0.5, ny: 0.5, button: 'left', pressed }
}

const telemetry = {
  version: 1,
  startedAt: 0,
  duration: 10000,
  sampleHz: 60,
  display: {
    id: 1, x: 0, y: 0, width: 1920, height: 1080,
    scaleFactor: 1, pixelWidth: 1920, pixelHeight: 1080,
  },
  cursor: [],
  clicks: [
    click(500, true), click(560, false),
    click(3000, true), click(3060, false),
    click(7000, true), click(7060, false),
    click(9500, true), click(9560, false),
  ],
  clicksAvailable: true,
} as Telemetry

const telemetries = new Map<string, Telemetry>([['t.json', telemetry]])

function recording(inMs: number, outMs: number): Clip {
  return {
    kind: 'recording',
    id: 'rec',
    inMs,
    outMs,
    volume: 1,
    manifest: {
      seekable: true, id: 'rec', dir: '', createdAt: 0, duration: 10000,
      videoPath: '', micPath: null, systemAudioPath: null, telemetryPath: 't.json',
    },
  }
}

const untrimmed: PlacedClip[] = [
  { clip: recording(0, 10000), index: 0, startT: 0, endT: 10000 },
]
const whole = collectClickTimes(untrimmed, telemetries)
ok('un son par appui, pas par relâchement', whole.length === 4, whole.length)
ok('aux instants des appuis', JSON.stringify(whole) === '[500,3000,7000,9500]', JSON.stringify(whole))

// Trimmed to 2s..8s and placed 5s into the timeline: the first and last clicks
// are cut away, and the survivors shift with the trim.
const trimmed: PlacedClip[] = [
  { clip: recording(2000, 8000), index: 0, startT: 5000, endT: 11000 },
]
const kept = collectClickTimes(trimmed, telemetries)
ok('les clics rognés sont écartés', kept.length === 2, kept.length)
ok('les survivants suivent le montage', JSON.stringify(kept) === '[6000,10000]', JSON.stringify(kept))

// Two clips, out of order on the timeline: the result has to be sorted, since
// the player walks it forward and never looks back.
const twice: PlacedClip[] = [
  { clip: { ...recording(0, 10000), id: 'b' }, index: 1, startT: 20000, endT: 30000 },
  { clip: { ...recording(0, 10000), id: 'a' }, index: 0, startT: 0, endT: 10000 },
]
const both = collectClickTimes(twice, telemetries)
const sorted = both.every((t, i) => i === 0 || both[i - 1] <= t)
ok('ordre croissant sur plusieurs clips', sorted && both.length === 8, both.length)

const noTelemetry = collectClickTimes(untrimmed, new Map())
ok('télémétrie absente -> aucun son', noTelemetry.length === 0)

console.log(failures === 0 ? '\n=== TOUT PASSE ===' : `\n=== ${failures} ECHEC(S) ===`)
process.exit(failures === 0 ? 0 : 1)
