/**
 * Validates the multi-clip sequence model and the 9:16 framing geometry.
 *
 * Run: npx esbuild scripts/seqcheck.ts --bundle --platform=node --format=cjs \
 *        --alias:@=./src --outfile=x.cjs && node x.cjs
 */
import { Sequence } from '../src/lib/sequence'
import { cropExtents } from '../src/lib/compositor'
import { computeFrame } from '../src/lib/compositor'
import { ZoomTrack, clampCenter, type ZoomSegment } from '../src/lib/zoom-engine'
import { DEFAULT_ZOOM_OPTIONS } from '../src/lib/zoom-engine'
import type { Clip } from '../src/types/project'
import type { CursorSample } from '../src/types/telemetry'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'OK  ' : 'ECHEC'} ${label}  ->  ${JSON.stringify(actual)}${ok ? '' : ` (attendu ${JSON.stringify(expected)})`}`)
}
function near(label: string, actual: number, expected: number, tol = 1e-3) {
  const ok = Math.abs(actual - expected) <= tol
  if (!ok) failures++
  console.log(`  ${ok ? 'OK  ' : 'ECHEC'} ${label}  ->  ${actual.toFixed(4)}${ok ? '' : ` (attendu ${expected.toFixed(4)})`}`)
}

/* ------------------------------------------------------------------ */
console.log('=== SEQUENCE : resolution temporelle ===')

const media = (id: string, dur: number, inMs = 0): Clip => ({
  kind: 'media',
  id,
  path: `${id}.mp4`,
  name: id,
  inMs,
  outMs: inMs + dur,
  volume: 1,
  width: 1920,
  height: 1080,
  hasAudio: true,
  hasVideo: true,
  sourceDurationMs: inMs + dur,
})

// intro 2s -> capture 5s -> outro 3s
const seq = new Sequence([media('intro', 2000), media('capture', 5000), media('outro', 3000)])

check('duree totale', seq.durationMs, 10000)
check('t=0        -> clip', seq.resolve(0)?.placed.clip.id, 'intro')
check('t=1999     -> clip', seq.resolve(1999)?.placed.clip.id, 'intro')
check('t=2000     -> clip (frontiere)', seq.resolve(2000)?.placed.clip.id, 'capture')
check('t=6999     -> clip', seq.resolve(6999)?.placed.clip.id, 'capture')
check('t=7000     -> clip (frontiere)', seq.resolve(7000)?.placed.clip.id, 'outro')
check('t=10000    -> clip (fin exacte)', seq.resolve(10000)?.placed.clip.id, 'outro')
check('t=99999    -> clip (au-dela)', seq.resolve(99999)?.placed.clip.id, 'outro')
check('t=2500     -> temps local', seq.resolve(2500)?.localMs, 500)
check('t=7100     -> temps local', seq.resolve(7100)?.localMs, 100)

// A trimmed clip must offset local time by its in-point.
const trimmed = new Sequence([media('trim', 3000, 4000)])
check('clip rogne : duree', trimmed.durationMs, 3000)
check('clip rogne : t=0 -> local', trimmed.resolve(0)?.localMs, 4000)
check('clip rogne : t=1500 -> local', trimmed.resolve(1500)?.localMs, 5500)

check('sequence vide', new Sequence([]).resolve(0), null)

/* ------------------------------------------------------------------ */
console.log('\n=== DECOUPAGE : couper ne doit rien changer a l\'image ===')

// Splitting is only safe if the frame shown at any t is identical before and
// after the cut. Anything else means the zoom track would sample elsewhere.
const whole = media('cap', 5000)
const before = new Sequence([whole])

const cutAt = 2000
const left = { ...whole, id: 'cap-L', outMs: cutAt }
const right = { ...whole, id: 'cap-R', inMs: cutAt }
const after = new Sequence([left, right])

check('duree preservee', after.durationMs, before.durationMs)

let drift = 0
for (let t = 0; t <= 5000; t += 97) {
  const a = before.resolve(t)!.localMs
  const b = after.resolve(t)!.localMs
  if (Math.abs(a - b) > 1e-9) drift++
}
check('temps source identique sur toute la duree', drift, 0)
check('juste avant la coupe -> moitie gauche', after.resolve(1999)?.placed.clip.id, 'cap-L')
check('a la coupe -> moitie droite', after.resolve(2000)?.placed.clip.id, 'cap-R')
check('temps source a la coupe', after.resolve(2000)?.localMs, 2000)

// Inserting a jingle between the halves must shift only what follows it.
const jingle = media('jingle', 1500)
const withJingle = new Sequence([left, jingle, right])
check('duree avec insertion', withJingle.durationMs, 6500)
check('avant insertion inchange', withJingle.resolve(1000)?.localMs, 1000)
check('insertion jouee', withJingle.resolve(2500)?.placed.clip.id, 'jingle')
check('capture reprend ou elle s\'etait arretee', withJingle.resolve(3500)?.localMs, 2000)

/* ------------------------------------------------------------------ */
console.log('\n=== GEOMETRIE 9:16 depuis une source 16:9 ===')

const SRC = 16 / 9
const OUT_V = 9 / 16
const OUT_H = 16 / 9

const e1 = cropExtents(SRC, OUT_H, 1)
near('16:9 vers 16:9, x1 : demi-largeur', e1.halfW, 0.5)
near('16:9 vers 16:9, x1 : demi-hauteur', e1.halfH, 0.5)

const e2 = cropExtents(SRC, OUT_V, 1)
near('16:9 vers 9:16, x1 : demi-largeur', e2.halfW, (9 / 16) / (16 / 9) / 2)
near('16:9 vers 9:16, x1 : demi-hauteur', e2.halfH, 0.5)

const e3 = cropExtents(SRC, OUT_V, 2)
near('16:9 vers 9:16, x2 : demi-largeur', e3.halfW, (9 / 16) / (16 / 9) / 4)
near('16:9 vers 9:16, x2 : demi-hauteur', e3.halfH, 0.25)

console.log('\n  -- bridage de la camera --')
const c1 = clampCenter(0.05, 0.5, e2.halfW, e2.halfH)
near('cx=0.05 bride au bord gauche', c1.cx, e2.halfW)
near('cy verrouille au centre (aucun jeu vertical)', c1.cy, 0.5)
const c2 = clampCenter(0.95, 0.9, e2.halfW, e2.halfH)
near('cx=0.95 bride au bord droit', c2.cx, 1 - e2.halfW)
near('cy=0.9 verrouille au centre', c2.cy, 0.5)

console.log('\n  -- rectangle de crop effectif (source 1920x1080 -> sortie 1080x1920) --')
const frame = computeFrame({ scale: 1, cx: 0.5, cy: 0.5 }, 1920, 1080, 1080, 1920, 'crop')
near('largeur du crop', frame.sw, 1080 * (1080 / 1920))
near('hauteur du crop', frame.sh, 1080)
near('crop dans le cadre (gauche)', frame.sx >= -1e-6 ? 1 : 0, 1)
near('crop dans le cadre (droite)', frame.sx + frame.sw <= 1920 + 1e-6 ? 1 : 0, 1)

/* ------------------------------------------------------------------ */
console.log('\n=== AUTO-FRAMING : la camera suit-elle le curseur ? ===')

// Cursor sweeps left to right across 4 seconds.
const cursor: CursorSample[] = []
for (let t = 0; t <= 4000; t += 16) {
  const nx = 0.1 + (t / 4000) * 0.8
  cursor.push({ t, x: 0, y: 0, nx, ny: 0.5 })
}

const noSegments: ZoomSegment[] = []
const framing = { sourceAspect: SRC, outAspect: OUT_V, followCursor: true }
const track = new ZoomTrack(4000, noSegments, DEFAULT_ZOOM_OPTIONS, framing, cursor)

let outOfBounds = 0
let maxLag = 0
for (let t = 500; t <= 4000; t += 100) {
  const f = track.sample(t)
  const { halfW, halfH } = cropExtents(SRC, OUT_V, f.scale)
  if (f.cx - halfW < -1e-6 || f.cx + halfW > 1 + 1e-6) outOfBounds++
  if (f.cy - halfH < -1e-6 || f.cy + halfH > 1 + 1e-6) outOfBounds++
  const expected = Math.min(1 - halfW, Math.max(halfW, 0.1 + (t / 4000) * 0.8))
  maxLag = Math.max(maxLag, Math.abs(f.cx - expected))
}
console.log(`  camera a t=500ms  : cx=${track.sample(500).cx.toFixed(3)}`)
console.log(`  camera a t=2000ms : cx=${track.sample(2000).cx.toFixed(3)}  (curseur ~0.500)`)
console.log(`  camera a t=3800ms : cx=${track.sample(3800).cx.toFixed(3)}  (curseur ~0.860)`)
check('jamais hors du cadre', outOfBounds, 0)
console.log(`  retard max du ressort : ${maxLag.toFixed(3)} (un suivi amorti doit trainer un peu)`)
const lagOk = maxLag > 0.001 && maxLag < 0.15
if (!lagOk) failures++
console.log(`  ${lagOk ? 'OK  ' : 'ECHEC'} retard plausible (0.001 < lag < 0.15)`)

/* ------------------------------------------------------------------ */
console.log(`\n=== ${failures === 0 ? 'TOUT PASSE' : `${failures} ECHEC(S)`} ===`)
process.exit(failures === 0 ? 0 : 1)
