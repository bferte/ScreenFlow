import type { Telemetry } from '@/types/telemetry'
import type { RecordingManifest } from '@/types/telemetry'

export interface RecorderOptions {
  sourceId: string
  displayId: number | null
  /** Physical pixel size to request from the capturer. */
  width: number
  height: number
  fps: number
  captureMic: boolean
  captureSystemAudio: boolean
  micDeviceId?: string
}

export interface RecorderWarnings {
  systemAudio: string | null
  mic: string | null
  clicks: string | null
}

/** Picks the best container/codec this Chromium build actually supports. */
function pickVideoMime(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
}

function pickAudioMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm']
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'audio/webm'
}

/**
 * Wraps a MediaRecorder so chunks accumulate and `stop()` resolves with the
 * finished Blob rather than firing an event.
 */
class TrackRecorder {
  private recorder: MediaRecorder
  private chunks: Blob[] = []

  constructor(stream: MediaStream, mimeType: string, bitsPerSecond?: number) {
    this.recorder = new MediaRecorder(stream, {
      mimeType,
      ...(bitsPerSecond ? { videoBitsPerSecond: bitsPerSecond } : {}),
    })
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
  }

  start(timesliceMs = 1000) {
    this.recorder.start(timesliceMs)
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      if (this.recorder.state === 'inactive') {
        resolve(new Blob(this.chunks, { type: this.recorder.mimeType }))
        return
      }
      this.recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: this.recorder.mimeType }))
      }
      this.recorder.stop()
    })
  }
}

export class ScreenRecorder {
  private videoRecorder: TrackRecorder | null = null
  private micRecorder: TrackRecorder | null = null
  private systemRecorder: TrackRecorder | null = null
  private streams: MediaStream[] = []
  private warnings: RecorderWarnings = { systemAudio: null, mic: null, clicks: null }

  /** Live preview stream, so the UI can show what is being captured. */
  previewStream: MediaStream | null = null

  async start(opts: RecorderOptions): Promise<RecorderWarnings> {
    this.warnings = { systemAudio: null, mic: null, clicks: null }

    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: opts.sourceId,
        maxWidth: opts.width,
        maxHeight: opts.height,
        minFrameRate: opts.fps,
        maxFrameRate: opts.fps,
      },
    } as unknown as MediaTrackConstraints

    // Chromium only exposes system loopback audio when it is requested in the
    // same getUserMedia call as the desktop video track.
    let desktopStream: MediaStream
    if (opts.captureSystemAudio) {
      try {
        desktopStream = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints,
          video,
        })
      } catch (err) {
        this.warnings.systemAudio =
          "Le son système n'a pas pu être capturé (loopback indisponible pour cette source). " +
          'La vidéo est enregistrée sans lui.'
        void err
        desktopStream = await navigator.mediaDevices.getUserMedia({ audio: false, video })
      }
    } else {
      desktopStream = await navigator.mediaDevices.getUserMedia({ audio: false, video })
    }
    this.streams.push(desktopStream)

    const videoTrack = desktopStream.getVideoTracks()[0]
    if (!videoTrack) throw new Error('Aucune piste vidéo retournée par la source de capture.')

    const systemTrack = desktopStream.getAudioTracks()[0] ?? null
    if (opts.captureSystemAudio && !systemTrack && !this.warnings.systemAudio) {
      this.warnings.systemAudio = "La source sélectionnée n'expose pas de son système."
    }

    // Mic lives in its own stream so it stays an independently mixable file.
    let micStream: MediaStream | null = null
    if (opts.captureMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId } } : {}),
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: false,
          },
        })
        this.streams.push(micStream)
      } catch (err) {
        this.warnings.mic = `Micro indisponible : ${err instanceof Error ? err.message : String(err)}`
      }
    }

    this.previewStream = new MediaStream([videoTrack])

    const videoMime = pickVideoMime()
    const audioMime = pickAudioMime()

    this.videoRecorder = new TrackRecorder(
      new MediaStream([videoTrack]),
      videoMime,
      // ~40 Mbps keeps text crisp at 60 fps on a 1440p+ desktop.
      40_000_000,
    )
    if (systemTrack) {
      this.systemRecorder = new TrackRecorder(new MediaStream([systemTrack]), audioMime)
    }
    if (micStream) {
      this.micRecorder = new TrackRecorder(micStream, audioMime)
    }

    // Telemetry clock starts here, then every recorder starts in the same tick
    // so the streams share a common t0 within a frame or two.
    const telemetry = await window.screenflow.startTelemetry(opts.displayId)
    if (!telemetry.clicksAvailable) {
      this.warnings.clicks =
        'Le hook clavier/souris global est indisponible : les positions du curseur sont ' +
        'enregistrées, mais pas les clics. Les zooms devront être placés à la main.'
    }

    this.videoRecorder.start()
    this.systemRecorder?.start()
    this.micRecorder?.start()

    return this.warnings
  }

  async stop(): Promise<RecordingManifest> {
    const telemetry: Telemetry = await window.screenflow.stopTelemetry()

    const [videoBlob, micBlob, systemBlob] = await Promise.all([
      this.videoRecorder ? this.videoRecorder.stop() : Promise.resolve(null),
      this.micRecorder ? this.micRecorder.stop() : Promise.resolve(null),
      this.systemRecorder ? this.systemRecorder.stop() : Promise.resolve(null),
    ])

    this.teardown()

    if (!videoBlob) throw new Error('Aucune vidéo enregistrée.')

    return window.screenflow.saveRecording({
      video: await videoBlob.arrayBuffer(),
      mic: micBlob ? await micBlob.arrayBuffer() : null,
      systemAudio: systemBlob ? await systemBlob.arrayBuffer() : null,
      telemetry,
    })
  }

  private teardown() {
    for (const stream of this.streams) {
      for (const track of stream.getTracks()) track.stop()
    }
    this.streams = []
    this.previewStream = null
    this.videoRecorder = null
    this.micRecorder = null
    this.systemRecorder = null
  }
}
