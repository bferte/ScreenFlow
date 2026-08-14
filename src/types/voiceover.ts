export type TtsProvider = 'openai' | 'elevenlabs'

/**
 * A voiceover placed on the timeline.
 *
 * A block only exists once its audio is on disk, which is why `audioPath` is
 * not nullable: an unsynthesised line is a draft in the panel, not an object on
 * the timeline. That split is what makes moving a block trivially safe —
 * nothing about a move can invalidate the audio.
 *
 * Times are milliseconds, matching telemetry, clips and the ducking curve.
 * A seconds-based field sitting next to `startT`/`inMs` everywhere else is how
 * factor-of-1000 bugs get in.
 */
interface VoiceoverBlockBase {
  id: string
  /** Label on the timeline. For synthesised blocks, the spoken text itself. */
  text: string
  /** Audio on disk: the TTS cache, or a file the user imported. */
  audioPath: string
  durationMs: number
  /** Start position on the timeline. The only field a drag changes. */
  timelineOffsetMs: number
  /** Linear gain, 1 = unchanged. */
  volume: number
}

/** Synthesised here, and therefore re-synthesisable from its text. */
export interface TtsVoiceoverBlock extends VoiceoverBlockBase {
  origin: 'tts'
  provider: TtsProvider
  /** Voice name (OpenAI) or voice id (ElevenLabs). */
  voiceId: string
}

/**
 * Audio produced elsewhere and imported as-is.
 *
 * Split from the synthesised case rather than left as optional fields: an
 * imported file has no provider and no source text, so "regenerate" is
 * meaningless for it. Making that a type distinction stops the UI from ever
 * offering the action, instead of relying on a runtime check nobody maintains.
 */
export interface ImportedVoiceoverBlock extends VoiceoverBlockBase {
  origin: 'imported'
  fileName: string
}

export type VoiceoverBlock = TtsVoiceoverBlock | ImportedVoiceoverBlock

/** Panel-only state for a line being written or generated. */
export interface VoiceoverDraft {
  id: string
  text: string
  status: 'idle' | 'generating' | 'error'
  error?: string
}

export interface TtsSettings {
  provider: TtsProvider
  openaiVoice: string
  openaiModel: string
  elevenVoiceId: string
  elevenModel: string
  /** Whether a key is stored, never the key itself. */
  hasOpenaiKey: boolean
  hasElevenKey: boolean
}

export const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
] as const

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  provider: 'openai',
  openaiVoice: 'alloy',
  openaiModel: 'gpt-4o-mini-tts',
  elevenVoiceId: '',
  elevenModel: 'eleven_multilingual_v2',
  hasOpenaiKey: false,
  hasElevenKey: false,
}

export const blockEndMs = (b: VoiceoverBlock) => b.timelineOffsetMs + b.durationMs

/** True while the block covers this timeline instant. */
export function blockCovers(b: VoiceoverBlock, tMs: number) {
  return tMs >= b.timelineOffsetMs && tMs < blockEndMs(b)
}
