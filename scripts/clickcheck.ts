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
import { renderClickBuffer, collectClickTimes } from '../src/lib/click-sound'
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

console.log('=== FORME D ONDE ===')
const a = renderClickBuffer(fakeContext(48000))
const first = a.getChannelData(0)

ok('durée ~90 ms', Math.abs(a.duration - 0.09) < 0.001, a.duration.toFixed(4) + 's')

let peak = 0
for (const v of first) peak = Math.max(peak, Math.abs(v))
ok('normalisé sous 0 dBFS', peak > 0.85 && peak <= 0.9001, peak.toFixed(4))

ok('démarre sur le transitoire', Math.abs(first[0]) > 0.2, first[0].toFixed(4))
ok('se termine sur le silence', Math.abs(first[first.length - 1]) < 1e-6, first[first.length - 1])

// Energy has to be front-loaded, or it reads as a tone rather than an impact.
const half = Math.floor(first.length / 2)
let head = 0
let tail = 0
for (let i = 0; i < first.length; i++) {
  if (i < half) head += first[i] * first[i]
  else tail += first[i] * first[i]
}
ok('énergie concentrée à l attaque', head > tail * 10, (head / tail).toFixed(1) + 'x')

console.log('\n=== DETERMINISME ===')
const b = renderClickBuffer(fakeContext(48000))
const second = b.getChannelData(0)
let identical = first.length === second.length
for (let i = 0; identical && i < first.length; i++) identical = first[i] === second[i]
ok('deux synthèses donnent le même échantillon', identical)

const c = renderClickBuffer(fakeContext(44100))
ok('suit la fréquence d échantillonnage', c.length === Math.ceil(0.09 * 44100), c.length)

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
