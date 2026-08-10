import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Local settings, including provider API keys.
 *
 * Keys live here and are never sent to the renderer: the renderer asks for
 * speech and gets back a file path, so a key cannot leak through DevTools, a
 * stray log, or any page-level code. `getPublicSettings` deliberately reports
 * only *whether* a key is present.
 *
 * This is a plain file in userData, readable by anything running as this user.
 * It is not a secret store — it protects against accidental exposure, not
 * against someone with access to the machine.
 */
export interface StoredSettings {
  provider: 'openai' | 'elevenlabs'
  openaiKey: string
  openaiVoice: string
  openaiModel: string
  elevenKey: string
  elevenVoiceId: string
  elevenModel: string
}

const DEFAULTS: StoredSettings = {
  provider: 'openai',
  openaiKey: '',
  openaiVoice: 'alloy',
  openaiModel: 'gpt-4o-mini-tts',
  elevenKey: '',
  elevenVoiceId: '',
  elevenModel: 'eleven_multilingual_v2',
}

let cache: StoredSettings | null = null

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<StoredSettings> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8')
    cache = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<StoredSettings>) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function saveSettings(patch: Partial<StoredSettings>): Promise<void> {
  const current = await loadSettings()
  cache = { ...current, ...patch }
  await fs.writeFile(settingsPath(), JSON.stringify(cache, null, 2), 'utf8')
}

/** Everything the renderer is allowed to know. Never includes a key. */
export async function getPublicSettings() {
  const s = await loadSettings()
  return {
    provider: s.provider,
    openaiVoice: s.openaiVoice,
    openaiModel: s.openaiModel,
    elevenVoiceId: s.elevenVoiceId,
    elevenModel: s.elevenModel,
    hasOpenaiKey: s.openaiKey.length > 0,
    hasElevenKey: s.elevenKey.length > 0,
  }
}
