import type { Clip } from '@/types/project'

interface Entry {
  clip: Clip
  el: HTMLVideoElement
  ready: boolean
}

/**
 * Holds one media element per clip and keeps exactly the active one playing.
 *
 * With a single recording the video element could be the clock. Across a
 * sequence it cannot: nothing decodes across a cut, and the timeline has to
 * keep advancing through audio-only clips and gaps. So the timeline owns the
 * clock and every element here is a slave, seeked to match it.
 */
export class MediaPool {
  private entries = new Map<string, Entry>()
  private disposed = false
  /** Resync threshold in seconds; below this, drift is imperceptible. */
  private static readonly MAX_DRIFT = 0.08

  constructor(clips: Clip[]) {
    for (const clip of clips) this.add(clip)
  }

  private add(clip: Clip) {
    const el = document.createElement('video')
    el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    el.playsInline = true
    // Media clips carry their own soundtrack; a recording's audio lives in
    // separate files handled by AudioEngine, so its video track stays muted.
    el.muted = clip.kind === 'recording'
    el.volume = clip.kind === 'recording' ? 0 : clip.volume

    const path = clip.kind === 'recording' ? clip.manifest.videoPath : clip.path
    el.src = window.screenflow.mediaUrl(path)

    const entry: Entry = { clip, el, ready: false }
    el.addEventListener('loadeddata', () => {
      entry.ready = true
      console.log('[MediaPool] prêt', clip.id, el.videoWidth + 'x' + el.videoHeight)
    })
    el.addEventListener('error', () => {
      console.error(
        `[MediaPool] erreur média ${clip.id} ` +
          JSON.stringify({ code: el.error?.code, message: el.error?.message, src: el.currentSrc }),
      )
    })
    this.entries.set(clip.id, entry)
    // Detached elements are not in the document, so nothing else will kick off
    // the resource selection algorithm for them.
    el.load()
  }

  get(clipId: string): HTMLVideoElement | null {
    const entry = this.entries.get(clipId)
    return entry && entry.ready ? entry.el : null
  }

  /** Snapshot for diagnostics: why is nothing drawing? */
  describe(clipId: string) {
    const entry = this.entries.get(clipId)
    // Distinguishing the two is what separates "not loaded yet" from "this
    // pool was disposed and nobody rebuilt it".
    if (!entry) return this.disposed ? { disposed: true } : { missing: true }
    return {
      ready: entry.ready,
      readyState: entry.el.readyState,
      networkState: entry.el.networkState,
      w: entry.el.videoWidth,
      h: entry.el.videoHeight,
      err: entry.el.error?.code ?? null,
      src: entry.el.currentSrc,
    }
  }

  dimensions(clipId: string): { width: number; height: number } | null {
    const el = this.get(clipId)
    if (!el || !el.videoWidth) return null
    return { width: el.videoWidth, height: el.videoHeight }
  }

  /** True once every clip that has video has decoded its first frame. */
  get allReady(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.clip.kind === 'media' && !entry.clip.hasVideo) continue
      if (!entry.ready) return false
    }
    return true
  }

  /**
   * Aligns every element with the timeline: the active clip plays at its local
   * time, all others stop so they neither burn CPU nor leak sound.
   */
  sync(activeClipId: string | null, localMs: number, playing: boolean) {
    for (const [id, entry] of this.entries) {
      const el = entry.el
      if (id !== activeClipId) {
        if (!el.paused) el.pause()
        continue
      }
      if (!entry.ready) continue

      const target = localMs / 1000
      if (Math.abs(el.currentTime - target) > MediaPool.MAX_DRIFT) {
        el.currentTime = target
      }
      if (playing && el.paused) void el.play().catch(() => undefined)
      else if (!playing && !el.paused) el.pause()
    }
  }

  setVolume(clipId: string, volume: number) {
    const entry = this.entries.get(clipId)
    if (entry && entry.clip.kind === 'media') entry.el.volume = Math.min(1, Math.max(0, volume))
  }

  /** Seeks one clip and resolves when the frame is decoded. Used by the exporter. */
  seekExact(clipId: string, localMs: number): Promise<void> {
    const entry = this.entries.get(clipId)
    if (!entry) return Promise.reject(new Error(`Clip inconnu : ${clipId}`))
    const el = entry.el
    const target = localMs / 1000

    return new Promise((resolve, reject) => {
      if (Math.abs(el.currentTime - target) < 1e-4 && el.readyState >= 2) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Seek bloqué à ${target.toFixed(3)}s sur ${clipId}`))
      }, 15000)
      const done = () => {
        cleanup()
        resolve()
      }
      const fail = () => {
        cleanup()
        reject(new Error(`Décodage impossible sur ${clipId}`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        el.removeEventListener('seeked', done)
        el.removeEventListener('error', fail)
      }
      el.addEventListener('seeked', done)
      el.addEventListener('error', fail)
      el.currentTime = target
    })
  }

  dispose() {
    this.disposed = true
    for (const { el } of this.entries.values()) {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
    this.entries.clear()
  }
}
