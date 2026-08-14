import { readFileSync } from 'node:fs'
import { generateSegments, buildZoomTrack, DEFAULT_ZOOM_OPTIONS } from '../src/lib/zoom-engine'

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

console.log(dwellFailures === 0 ? '\n=== TOUT PASSE ===' : `\n=== ${dwellFailures} ECHEC(S) ===`)
process.exit(dwellFailures === 0 ? 0 : 1)
