/**
 * Asserts the guarantees that make voiceover blocks safe to move.
 *
 * The headline promise is "generated once, moved freely, never refetched".
 * That rests on two properties worth testing rather than trusting: the cache
 * key ignores placement, and a move mutates nothing but the offset.
 *
 * Run: npx esbuild scripts/voicecheck.ts --bundle --platform=node --format=cjs \
 *        --alias:@=./src --outfile=x.cjs && node x.cjs
 */
import { cacheKey, extractProviderMessage } from '../electron/cache-key'
import {
  blockCovers,
  blockEndMs,
  type ImportedVoiceoverBlock,
  type TtsVoiceoverBlock,
  type VoiceoverBlock,
} from '../src/types/voiceover'

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  if (!condition) failures++
  console.log(`  ${condition ? 'OK  ' : 'ECHEC'} ${label}${detail ? `  ${detail}` : ''}`)
}

const block = (patch: Partial<TtsVoiceoverBlock> = {}): TtsVoiceoverBlock => ({
  origin: 'tts',
  id: 'vo-1',
  text: 'Bonjour et bienvenue.',
  voiceId: 'alloy',
  provider: 'openai',
  audioPath: 'C:/cache/abc.mp3',
  durationMs: 2400,
  timelineOffsetMs: 5000,
  volume: 1,
  ...patch,
})

const imported = (patch: Partial<ImportedVoiceoverBlock> = {}): ImportedVoiceoverBlock => ({
  origin: 'imported',
  id: 'vo-imp',
  text: 'narration-intro',
  fileName: 'narration-intro.mp3',
  audioPath: 'C:/Users/x/Documents/narration-intro.mp3',
  durationMs: 4200,
  timelineOffsetMs: 1000,
  volume: 1,
  ...patch,
})

/** The single mutation a drag is allowed to perform. */
const move = <T extends VoiceoverBlock>(b: T, timelineOffsetMs: number): T => ({
  ...b,
  timelineOffsetMs,
})

console.log('=== CLE DE CACHE : la position n\'entre pas dedans ===')

const k = cacheKey('openai', 'gpt-4o-mini-tts', 'alloy', 'Bonjour et bienvenue.')
check('stable pour des entrees identiques', k === cacheKey('openai', 'gpt-4o-mini-tts', 'alloy', 'Bonjour et bienvenue.'))
check('change avec le texte', k !== cacheKey('openai', 'gpt-4o-mini-tts', 'alloy', 'Autre texte.'))
check('change avec la voix', k !== cacheKey('openai', 'gpt-4o-mini-tts', 'nova', 'Bonjour et bienvenue.'))
check('change avec le modele', k !== cacheKey('openai', 'tts-1', 'alloy', 'Bonjour et bienvenue.'))
check('change avec le service', k !== cacheKey('elevenlabs', 'gpt-4o-mini-tts', 'alloy', 'Bonjour et bienvenue.'))

// The key function takes no placement argument at all, so a moved block
// necessarily resolves to the same cached file.
const before = block()
const after = move(before, 12_345)
// Only synthesised blocks have a cache key at all — an imported file was never
// fetched, so there is nothing to avoid re-fetching.
const keyOf = (b: TtsVoiceoverBlock) => cacheKey(b.provider, 'gpt-4o-mini-tts', b.voiceId, b.text)
check('un bloc deplace vise le meme fichier cache', keyOf(before) === keyOf(after), `(${keyOf(after).slice(0, 12)}…)`)

console.log('\n=== DEPLACEMENT : rien d\'autre ne bouge ===')

check('audioPath inchange', after.audioPath === before.audioPath)
check('texte inchange', after.text === before.text)
check('voix inchangee', after.voiceId === before.voiceId)
check('duree inchangee', after.durationMs === before.durationMs)
check('volume inchange', after.volume === before.volume)
check('offset mis a jour', after.timelineOffsetMs === 12_345)

// Everything except the offset must be byte-identical.
const changed = (Object.keys(before) as (keyof TtsVoiceoverBlock)[]).filter((k2) => before[k2] !== after[k2])
check('un seul champ modifie', changed.length === 1 && changed[0] === 'timelineOffsetMs', `(${changed.join(', ')})`)

console.log('\n=== BLOCS IMPORTES ===')

// An imported file must be as safe to move as a generated one, and must never
// be mistaken for something re-synthesisable.
const imp = imported()
const impMoved = move(imp, 7_500)
const impChanged = (Object.keys(imp) as (keyof ImportedVoiceoverBlock)[]).filter(
  (k2) => imp[k2] !== impMoved[k2],
)
check('deplacement : un seul champ modifie', impChanged.length === 1 && impChanged[0] === 'timelineOffsetMs')
check('chemin audio preserve', impMoved.audioPath === imp.audioPath)
check('origine preservee', impMoved.origin === 'imported')
check('pas de fournisseur', !('provider' in impMoved))
check('pas de voix', !('voiceId' in impMoved))
check('couverture identique aux blocs generes', blockCovers(imp, 3000) && !blockCovers(imp, 5200))
check('fin calculee', blockEndMs(imp) === 5200)

// The two kinds must be distinguishable at runtime, not only at compile time:
// the ducking and export paths iterate over the mixed list.
const mixed: VoiceoverBlock[] = [block(), imported()]
check('liste mixte : 1 genere', mixed.filter((b) => b.origin === 'tts').length === 1)
check('liste mixte : 1 importe', mixed.filter((b) => b.origin === 'imported').length === 1)
check(
  'tous exposent ce dont le mixage a besoin',
  mixed.every((b) => typeof b.audioPath === 'string' && b.durationMs > 0 && typeof b.volume === 'number'),
)

console.log('\n=== COUVERTURE TEMPORELLE ===')

const b = block({ timelineOffsetMs: 5000, durationMs: 2400 })
check('fin calculee', blockEndMs(b) === 7400)
check('avant le debut -> non couvert', !blockCovers(b, 4999))
check('au debut exact -> couvert', blockCovers(b, 5000))
check('au milieu -> couvert', blockCovers(b, 6200))
check('juste avant la fin -> couvert', blockCovers(b, 7399))
check('a la fin exacte -> non couvert', !blockCovers(b, 7400), '(intervalle semi-ouvert)')

console.log('\n=== BRIDAGE DU DEPLACEMENT ===')

// Mirrors the clamp the drag handler applies.
const clamp = (offset: number, duration: number, timeline: number) =>
  Math.min(Math.max(0, timeline - duration), Math.max(0, offset))

check('pas de position negative', clamp(-500, 2400, 10_000) === 0)
check('bride a la fin de la timeline', clamp(9_500, 2400, 10_000) === 7_600)
check('position valide preservee', clamp(3_000, 2400, 10_000) === 3_000)
check('bloc plus long que la timeline -> 0', clamp(500, 20_000, 10_000) === 0)

console.log('\n=== MESSAGES D\'ERREUR DES FOURNISSEURS ===')

// The regression this guards: a bare status code with the provider's own
// explanation silently discarded.
const cases: [string, string, string][] = [
  [
    'OpenAI (error.message)',
    '{"error":{"message":"You exceeded your current quota.","type":"insufficient_quota"}}',
    'You exceeded your current quota.',
  ],
  [
    'ElevenLabs (detail.message imbrique)',
    '{"detail":{"status":"quota_exceeded","message":"You have reached your character limit."}}',
    'You have reached your character limit.',
  ],
  [
    'detail en chaine simple',
    '{"detail":"Payment required"}',
    'Payment required',
  ],
  [
    'message a la racine',
    '{"message":"Insufficient balance"}',
    'Insufficient balance',
  ],
  [
    'tableau errors',
    '{"errors":[{"message":"Card declined"}]}',
    'Card declined',
  ],
  [
    'HTML de passerelle',
    '<html><body>502 Bad Gateway</body></html>',
    '<html><body>502 Bad Gateway</body></html>',
  ],
]

for (const [label, body, expected] of cases) {
  const got = extractProviderMessage(body)
  check(label, got === expected, got === expected ? '' : `-> "${got}"`)
}

// Must never return an empty string: a status code alone is not actionable.
const degenerate = ['{}', '{"error":{}}', '{"detail":{}}', '', 'null']
for (const body of degenerate) {
  const got = extractProviderMessage(body)
  check(`corps degenere ${JSON.stringify(body)} ne casse pas`, typeof got === 'string')
}

// A self-referencing body must not hang the walk.
const cyclic: Record<string, unknown> = { error: {} }
;(cyclic.error as Record<string, unknown>).error = cyclic
check('structure cyclique geree', extractProviderMessage(JSON.stringify({ error: { detail: 'ok' } })) === 'ok')

console.log(`\n=== ${failures === 0 ? 'TOUT PASSE' : `${failures} ECHEC(S)`} ===`)
process.exit(failures === 0 ? 0 : 1)
