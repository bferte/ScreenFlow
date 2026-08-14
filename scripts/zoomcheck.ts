import { readFileSync } from 'node:fs'
import {
  DEFAULT_ZOOM_OPTIONS,
  MIN_SEGMENT_MS,
  ZoomTrack,
  buildZoomTrack,
  createSegment,
  generateSegments,
  reshapeSegment,
} from '../src/lib/zoom-engine'

const file = process.argv[2]
const t = JSON.parse(readFileSync(file, 'utf8'))

const segments = generateSegments(t.clicks, DEFAULT_ZOOM_OPTIONS, t.cursor)
console.log('=== SEGMENTS ===')
console.log('clics down :', t.clicks.filter((c: { pressed: boolean }) => c.pressed).length)
console.log('segments   :', segments.length)
for (const s of segments) {
  console.log(
    `  ${s.id}  ${String(s.startT).padStart(5)}->${String(Math.round(s.endT)).padStart(5)}ms  ` +
      `focus(${s.nx.toFixed(3)}, ${s.ny.toFixed(3)})  x${s.scale}  ${s.clickCount} clic(s)`,
  )
}

const track = buildZoomTrack(t, DEFAULT_ZOOM_OPTIONS, segments)

console.log('\n=== TRAJECTOIRE (toutes les 250ms) ===')
let maxScale = 0
let minScale = Infinity
let outOfBounds = 0
for (let ms = 0; ms <= t.duration; ms += 250) {
  const f = track.sample(ms)
  maxScale = Math.max(maxScale, f.scale)
  minScale = Math.min(minScale, f.scale)
  const half = 0.5 / f.scale
  if (f.cx - half < -1e-6 || f.cx + half > 1 + 1e-6 || f.cy - half < -1e-6 || f.cy + half > 1 + 1e-6) {
    outOfBounds++
  }
  const bar = '#'.repeat(Math.round((f.scale - 1) * 30))
  console.log(
    `${String(ms).padStart(5)}ms  x${f.scale.toFixed(3)}  (${f.cx.toFixed(3)}, ${f.cy.toFixed(3)}) ${bar}`,
  )
}

console.log('\n=== CONTROLES ===')
console.log('scale min / max        :', minScale.toFixed(4), '/', maxScale.toFixed(4))
console.log('depassement du cadre   :', outOfBounds, '(doit etre 0)')
console.log('scale a t=0            :', track.sample(0).scale.toFixed(4), '(doit etre 1.0000)')
console.log(
  'overshoot (damping=1)  :',
  maxScale > DEFAULT_ZOOM_OPTIONS.scale + 0.001 ? 'OUI - anormal' : 'non',
)

const times = [0, 1000, 2000, 3000, 4000, 5000]
const forward = times.map((ms) => track.sample(ms).scale)
const backward = [...times].reverse().map((ms) => track.sample(ms).scale).reverse()
console.log(
  'deterministe au seek   :',
  times.every((_, i) => Math.abs(forward[i] - backward[i]) < 1e-12) ? 'OUI' : 'NON',
)

/* ------------------------------------------------------------------ *
 * Dwell: does the zoom hold while the cursor sits still?
 *
 * Self-contained — clicking a field and typing into it is exactly the case a
 * real capture is least likely to contain on purpose.
 * ------------------------------------------------------------------ */

console.log('\n=== MAINTIEN SUR CURSEUR IMMOBILE ===')

let dwellFailures = 0
function expect(label: string, actual: number, wanted: number) {
  const pass = Math.abs(actual - wanted) <= 20
  console.log(`  ${pass ? 'OK  ' : 'ECHEC'} ${label}  ->  fin à ${Math.round(actual)}ms (attendu ${wanted})`)
  if (!pass) dwellFailures++
}

const CLICK_T = 2000
const FOCUS = { nx: 0.4, ny: 0.5 }

/** Cursor parked on the click point until `leaveAt`, then away. */
function cursorLeavingAt(leaveAt: number, untilMs = 20000) {
  const samples = []
  for (let t = 0; t <= untilMs; t += 16) {
    const away = t >= leaveAt
    samples.push({
      t,
      x: 0,
      y: 0,
      nx: away ? 0.9 : FOCUS.nx,
      ny: away ? 0.9 : FOCUS.ny,
    })
  }
  return samples
}

const oneClick = [
  { t: CLICK_T, x: 0, y: 0, ...FOCUS, button: 'left' as const, pressed: true },
  { t: CLICK_T + 80, x: 0, y: 0, ...FOCUS, button: 'left' as const, pressed: false },
]
const hold = DEFAULT_ZOOM_OPTIONS.holdMs

expect(
  'la souris repart aussitôt : comportement inchangé',
  generateSegments(oneClick, DEFAULT_ZOOM_OPTIONS, cursorLeavingAt(CLICK_T))[0].endT,
  CLICK_T + hold,
)

expect(
  'frappe de 3 s dans le champ, puis la souris repart',
  generateSegments(oneClick, DEFAULT_ZOOM_OPTIONS, cursorLeavingAt(CLICK_T + 3000))[0].endT,
  CLICK_T + 3000 + hold,
)

expect(
  'souris jamais repartie : bridé par dwellMaxMs',
  generateSegments(oneClick, DEFAULT_ZOOM_OPTIONS, cursorLeavingAt(Infinity))[0].endT,
  CLICK_T + DEFAULT_ZOOM_OPTIONS.dwellMaxMs + hold,
)

expect(
  'dwellMaxMs à 0 : la fonction est désactivée',
  generateSegments(oneClick, { ...DEFAULT_ZOOM_OPTIONS, dwellMaxMs: 0 }, cursorLeavingAt(Infinity))[0]
    .endT,
  CLICK_T + hold,
)

expect(
  'aucune télémétrie curseur : comportement inchangé',
  generateSegments(oneClick, DEFAULT_ZOOM_OPTIONS)[0].endT,
  CLICK_T + hold,
)

// A drift smaller than the radius is still the same spot: a hand resting on the
// mouse moves it a pixel or two without meaning anything by it.
const jitter = cursorLeavingAt(Infinity).map((s) => ({
  ...s,
  nx: s.nx + (s.t % 300 === 0 ? 0.02 : 0),
}))
expect(
  'micro-tremblement sous le rayon : le maintien tient',
  generateSegments(oneClick, DEFAULT_ZOOM_OPTIONS, jitter)[0].endT,
  CLICK_T + DEFAULT_ZOOM_OPTIONS.dwellMaxMs + hold,
)

// The dwell must never cost a segment its own focus. Two clicks far apart with
// the cursor parked on the first: extending that hold across the second click
// would let resolveGaps fuse them and centre the zoom between the two — on
// neither of the things that were clicked.
const twoPlaces = [
  { t: 2000, x: 0, y: 0, nx: 0.2, ny: 0.3, button: 'left' as const, pressed: true },
  { t: 2080, x: 0, y: 0, nx: 0.2, ny: 0.3, button: 'left' as const, pressed: false },
  { t: 6000, x: 0, y: 0, nx: 0.8, ny: 0.7, button: 'left' as const, pressed: true },
  { t: 6080, x: 0, y: 0, nx: 0.8, ny: 0.7, button: 'left' as const, pressed: false },
]
const parked = []
for (let t = 0; t <= 12000; t += 16) {
  const moved = t >= 5800
  parked.push({ t, x: 0, y: 0, nx: moved ? 0.8 : 0.2, ny: moved ? 0.7 : 0.3 })
}
const kept = generateSegments(twoPlaces, DEFAULT_ZOOM_OPTIONS, parked)
const separated =
  kept.length === 2 && Math.abs(kept[0].nx - 0.2) < 1e-9 && Math.abs(kept[1].nx - 0.8) < 1e-9
console.log(
  `  ${separated ? 'OK  ' : 'ECHEC'} le maintien cède la place au clic suivant  ->  ` +
    kept.map((s) => s.nx.toFixed(2)).join(' / '),
)
if (!separated) dwellFailures++

// ...but a real double click on one spot is still a single zoom.
const double = [
  { t: 2000, x: 0, y: 0, nx: 0.4, ny: 0.4, button: 'left' as const, pressed: true },
  { t: 2080, x: 0, y: 0, nx: 0.4, ny: 0.4, button: 'left' as const, pressed: false },
  { t: 2260, x: 0, y: 0, nx: 0.41, ny: 0.4, button: 'left' as const, pressed: true },
  { t: 2340, x: 0, y: 0, nx: 0.41, ny: 0.4, button: 'left' as const, pressed: false },
]
const fused = generateSegments(double, DEFAULT_ZOOM_OPTIONS, parked)
console.log(
  `  ${fused.length === 1 ? 'OK  ' : 'ECHEC'} un double clic reste un seul zoom  ->  ${fused.length}`,
)
if (fused.length !== 1) dwellFailures++

if (dwellFailures > 0) console.log(`  ${dwellFailures} echec(s) sur le maintien`)

/* ------------------------------------------------------------------ *
 * Hand editing
 * ------------------------------------------------------------------ */

console.log('\n=== EDITION MANUELLE ===')

let editFailures = 0
function check(label: string, pass: boolean, detail: string | number = '') {
  console.log(`  ${pass ? 'OK  ' : 'ECHEC'} ${label}${detail === '' ? '' : `  ->  ${detail}`}`)
  if (!pass) editFailures++
}

const base = generateSegments(oneClick, DEFAULT_ZOOM_OPTIONS)[0]

const widened = reshapeSegment(base, 500, 8000, 10000)
check('les bornes suivent le geste', widened.startT === 500 && widened.endT === 8000)
check('le segment redimensionné est marqué manuel', widened.auto === false)

const inverted = reshapeSegment(base, 5000, 1000, 10000)
check(
  'bords croisés : la durée minimale est imposée',
  inverted.endT - inverted.startT === MIN_SEGMENT_MS,
  `${inverted.startT}->${inverted.endT}`,
)

const beyond = reshapeSegment(base, -500, 99999, 10000)
check('bridé dans la durée du clip', beyond.startT === 0 && beyond.endT === 10000,
  `${beyond.startT}->${beyond.endT}`)

const late = reshapeSegment(base, 9990, 12000, 10000)
check(
  'un début au-delà de la fin laisse la place au minimum',
  late.startT <= 10000 - MIN_SEGMENT_MS && late.endT === 10000,
  `${late.startT}->${late.endT}`,
)

const made = createSegment('manuel-1', 1000, 2600, 0.3, 0.7, DEFAULT_ZOOM_OPTIONS)
check('un zoom créé à la main ne revendique aucun clic', made.clickCount === 0 && !made.auto)
check('il vise le point demandé', made.nx === 0.3 && made.ny === 0.7)

// Overlapping is legal once a hand is involved: targetAt takes the last match,
// so the later segment wins instead of leaving a hole.
const overlapping = [
  createSegment('a', 0, 4000, 0.2, 0.2),
  createSegment('b', 2000, 6000, 0.8, 0.8),
]
const overlapTrack = new ZoomTrack(8000, overlapping, DEFAULT_ZOOM_OPTIONS)
const inOverlap = overlapTrack.sample(3000)
check('sur recouvrement, le segment le plus tardif gagne', inOverlap.cx > 0.5, inOverlap.cx.toFixed(3))

console.log(editFailures === 0 ? '\n=== TOUT PASSE ===' : `\n=== ${editFailures} ECHEC(S) ===`)
process.exit(dwellFailures + editFailures === 0 ? 0 : 1)
