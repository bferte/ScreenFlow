import { app, net } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { loadSettings } from './settings'
import { probeMedia } from './ffmpeg'
import { cacheKey, extractProviderMessage } from './cache-key'

export interface SpeakRequest {
  text: string
  /** Overrides the stored default when set. */
  provider?: 'openai' | 'elevenlabs'
  voice?: string
}

export interface SpeakResult {
  audioPath: string
  durationMs: number
}

function voiceoverDir() {
  return path.join(app.getPath('userData'), 'voiceover')
}

/**
 * Turns a failed response into something the user can act on.
 *
 * Providers disagree on where the reason lives: OpenAI nests it under
 * `error.message`, ElevenLabs under `detail.message` — an *object*, not a
 * string. An earlier version tested `typeof detail === 'string'` and silently
 * dropped the whole explanation whenever it was nested, leaving a bare status
 * code. `extractProviderMessage` walks the shapes instead.
 */
async function describeFailure(response: Response, provider: string): Promise<string> {
  let detail = ''
  try {
    detail = extractProviderMessage(await response.text())
  } catch {
    /* body already consumed or unreadable */
  }

  // Logged so a failure is diagnosable from the terminal. Response bodies never
  // contain the API key, which is only ever sent in a request header.
  console.warn(`[tts] ${provider} a répondu ${response.status}`, detail)

  const label = provider === 'openai' ? 'OpenAI' : 'ElevenLabs'
  const billing =
    provider === 'openai'
      ? 'Vérifie le solde et le moyen de paiement sur platform.openai.com/settings/organization/billing.'
      : 'Vérifie ton abonnement et ton quota de caractères sur elevenlabs.io/subscription.'

  switch (response.status) {
    case 401:
    case 403:
      return `Clé ${label} refusée (${response.status}). Vérifie-la dans les paramètres.\n${detail}`.trim()
    case 402:
      return `${label} demande un paiement (402) : le compte n'a pas de crédit utilisable.\n${billing}\n${detail}`.trim()
    case 404:
      return `Modèle ou voix introuvable (404) chez ${label}. Vérifie ces deux réglages.\n${detail}`.trim()
    case 429:
      return `Quota ou limite de débit atteint (429) chez ${label}.\n${billing}\n${detail}`.trim()
    default:
      return response.status >= 500
        ? `${label} est indisponible (${response.status}). Réessaie dans un moment.\n${detail}`.trim()
        : `${label} a répondu ${response.status}.\n${detail}`.trim()
  }
}

/**
 * Generates speech and writes it next to the app's data.
 *
 * Runs in the main process on purpose: the API key never crosses into the
 * renderer, so no page-level code or DevTools session can read it.
 */
export async function speak(req: SpeakRequest): Promise<SpeakResult> {
  const text = req.text.trim()
  if (!text) throw new Error('Le texte est vide.')

  const settings = await loadSettings()
  const provider = req.provider ?? settings.provider

  const model = provider === 'openai' ? settings.openaiModel : settings.elevenModel
  const voice = req.voice ?? (provider === 'openai' ? settings.openaiVoice : settings.elevenVoiceId)

  await fs.mkdir(voiceoverDir(), { recursive: true })
  const file = path.join(voiceoverDir(), `${cacheKey(provider, model, voice, text)}.mp3`)

  try {
    await fs.access(file)
    const cached = await probeMedia(file)
    if (cached.durationMs > 0) return { audioPath: file, durationMs: cached.durationMs }
  } catch {
    /* not cached yet */
  }

  let response: Response
  if (provider === 'openai') {
    if (!settings.openaiKey) throw new Error('Aucune clé OpenAI enregistrée.')
    response = await net.fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input: text, voice, response_format: 'mp3' }),
    })
  } else {
    if (!settings.elevenKey) throw new Error('Aucune clé ElevenLabs enregistrée.')
    if (!voice) throw new Error('Aucun identifiant de voix ElevenLabs configuré.')
    response = await net.fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': settings.elevenKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: model }),
      },
    )
  }

  if (!response.ok) throw new Error(await describeFailure(response, provider))

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('Le service a renvoyé un fichier audio vide.')
  await fs.writeFile(file, bytes)

  const info = await probeMedia(file)
  if (info.durationMs <= 0) {
    await fs.rm(file, { force: true })
    throw new Error('Audio généré illisible (durée nulle).')
  }

  return { audioPath: file, durationMs: info.durationMs }
}

export function voiceoverRoot() {
  return voiceoverDir()
}
