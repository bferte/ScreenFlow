import { DuckingEnvelope, type DuckingOptions, type SpeechSource } from './ducking'
import { Sequence } from './sequence'
import { clipDuration, type Clip } from '@/types/project'
import type { VoiceoverBlock } from '@/types/voiceover'

async function decode(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url)
  return ctx.decodeAudioData(await response.arrayBuffer())
}

/**
 * Gathers every track that counts as *speech* and places it on the timeline.
 *
 * Two kinds qualify: each recording's mic, positioned at its clip's offset, and
 * every generated voiceover cue at its own start. What gets ducked in response
 * is the other material — system audio and imported clips.
 *
 * Failures are swallowed per source rather than aborting: a jingle with an
 * exotic codec should cost its own ducking contribution, not the whole curve.
 */
export async function collectSpeechSources(
  ctx: BaseAudioContext,
  clips: Clip[],
  blocks: VoiceoverBlock[],
): Promise<{ sources: SpeechSource[]; warnings: string[] }> {
  const sources: SpeechSource[] = []
  const warnings: string[] = []
  const sequence = new Sequence(clips)

  for (const placed of sequence.placed) {
    const { clip, startT } = placed
    if (clip.kind !== 'recording' || !clip.manifest.micPath) continue
    try {
      const buffer = await decode(ctx, window.screenflow.mediaUrl(clip.manifest.micPath))
      sources.push({
        buffer,
        offsetMs: startT,
        inMs: clip.inMs,
        durationMs: clipDuration(clip),
      })
    } catch {
      warnings.push('Piste micro illisible pour le ducking.')
    }
  }

  for (const block of blocks) {
    try {
      const buffer = await decode(ctx, window.screenflow.mediaUrl(block.audioPath))
      sources.push({
        buffer,
        offsetMs: block.timelineOffsetMs,
        inMs: 0,
        durationMs: block.durationMs,
      })
    } catch {
      warnings.push(`Voix-off « ${block.text.slice(0, 24)}… » illisible.`)
    }
  }

  return { sources, warnings }
}

/** Builds the timeline-wide ducking curve. */
export async function buildTimelineEnvelope(
  clips: Clip[],
  blocks: VoiceoverBlock[],
  durationMs: number,
  opts: DuckingOptions,
  enabled: boolean,
): Promise<{ envelope: DuckingEnvelope; warnings: string[] }> {
  if (!enabled || durationMs <= 0) {
    return { envelope: DuckingEnvelope.silent(Math.max(0, durationMs)), warnings: [] }
  }
  // A short-lived context purely for decoding; nothing is played through it.
  const ctx = new AudioContext()
  try {
    const { sources, warnings } = await collectSpeechSources(ctx, clips, blocks)
    return { envelope: DuckingEnvelope.fromSources(sources, durationMs, opts), warnings }
  } finally {
    void ctx.close()
  }
}
