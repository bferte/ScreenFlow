import { blockCovers, type VoiceoverBlock } from '@/types/voiceover'

interface Entry {
  block: VoiceoverBlock
  el: HTMLAudioElement
}

/**
 * Plays voiceover blocks against the timeline clock.
 *
 * Blocks are positioned in timeline time and may span clip cuts, so they are
 * driven straight from the master clock rather than slaved to any media
 * element. Only the blocks covering the playhead are unpaused.
 */
export class VoiceoverEngine {
  private entries = new Map<string, Entry>()
  private static readonly MAX_DRIFT = 0.08

  volume = 1

  /**
   * Adds, updates and drops elements so the pool matches the block list.
   *
   * Elements are keyed on `audioPath`, not on the block: moving a block leaves
   * its audio untouched, so a drag must not tear down and reload the element.
   */
  reconcile(blocks: VoiceoverBlock[]) {
    const wanted = new Set<string>()

    for (const block of blocks) {
      wanted.add(block.id)
      const existing = this.entries.get(block.id)

      if (existing) {
        if (existing.block.audioPath !== block.audioPath) {
          existing.el.src = window.screenflow.mediaUrl(block.audioPath)
          existing.el.load()
        }
        existing.block = block
        continue
      }

      const el = new Audio()
      el.preload = 'auto'
      el.src = window.screenflow.mediaUrl(block.audioPath)
      el.load()
      this.entries.set(block.id, { block, el })
    }

    for (const [id, entry] of this.entries) {
      if (wanted.has(id)) continue
      entry.el.pause()
      entry.el.removeAttribute('src')
      this.entries.delete(id)
    }
  }

  sync(timelineMs: number, playing: boolean) {
    for (const { block, el } of this.entries.values()) {
      el.volume = Math.min(1, Math.max(0, this.volume * block.volume))

      if (!blockCovers(block, timelineMs)) {
        if (!el.paused) el.pause()
        continue
      }

      const target = (timelineMs - block.timelineOffsetMs) / 1000
      if (Math.abs(el.currentTime - target) > VoiceoverEngine.MAX_DRIFT) {
        el.currentTime = target
      }
      if (playing && el.paused) void el.play().catch(() => undefined)
      else if (!playing && !el.paused) el.pause()
    }
  }

  dispose() {
    for (const { el } of this.entries.values()) {
      el.pause()
      el.removeAttribute('src')
    }
    this.entries.clear()
  }
}
