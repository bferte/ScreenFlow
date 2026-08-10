import { readFileSync } from 'node:fs'
import { generateSegments, buildZoomTrack, DEFAULT_ZOOM_OPTIONS } from '../src/lib/zoom-engine'

const file = process.argv[2]
const t = JSON.parse(readFileSync(file, 'utf8'))

const segments = generateSegments(t.clicks, DEFAULT_ZOOM_OPTIONS)
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
