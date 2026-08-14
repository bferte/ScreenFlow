import { contextBridge, ipcRenderer } from 'electron'
import type { DisplayInfo, RecordingManifest, Telemetry } from '../src/types/telemetry'

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  displayId: number | null
  thumbnail: string
}

export interface TelemetryStartResult {
  startedAt: number
  clicksAvailable: boolean
  hookError: string | null
}

export interface SavePayload {
  video: ArrayBuffer
  mic: ArrayBuffer | null
  systemAudio: ArrayBuffer | null
  telemetry: Telemetry
}

const api = {
  /**
   * Turns an absolute path into a URL the custom streaming protocol serves.
   *
   * The `local` host is not decorative: the scheme is registered as standard,
   * and a standard URL with an empty authority (`screenflow:///C:/...`) is
   * invalid, so Chromium never issues the request at all.
   */
  mediaUrl: (filePath: string): string =>
    `screenflow://local/${encodeURI(filePath.replace(/\\/g, '/'))}`,

  listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('capture:list-sources'),
  primaryDisplay: (): Promise<DisplayInfo> => ipcRenderer.invoke('capture:primary-display'),

  startTelemetry: (displayId: number | null): Promise<TelemetryStartResult> =>
    ipcRenderer.invoke('telemetry:start', displayId),
  stopTelemetry: (): Promise<Telemetry> => ipcRenderer.invoke('telemetry:stop'),

  saveRecording: (payload: SavePayload): Promise<RecordingManifest> =>
    ipcRenderer.invoke('recording:save', payload),
  listRecordings: (): Promise<RecordingManifest[]> => ipcRenderer.invoke('recording:list'),
  renameRecording: (id: string, name: string): Promise<RecordingManifest> =>
    ipcRenderer.invoke('recording:rename', id, name),
  /** Resolves `{ trashed: false }` when the platform had no trash to move it to. */
  deleteRecording: (id: string): Promise<{ trashed: boolean }> =>
    ipcRenderer.invoke('recording:delete', id),
  readTelemetry: (telemetryPath: string): Promise<Telemetry> =>
    ipcRenderer.invoke('recording:read-telemetry', telemetryPath),
  reveal: (target: string): Promise<void> => ipcRenderer.invoke('recording:reveal', target),

  /** `audio` narrows the file dialog to sound files, e.g. for voiceover. */
  importMedia: (
    kind: 'media' | 'audio' = 'media',
  ): Promise<
    {
      path: string
      name: string
      durationMs: number
      width: number | null
      height: number | null
      hasAudio: boolean
      hasVideo: boolean
    }[]
  > => ipcRenderer.invoke('media:import', kind),

  /**
   * Settings never round-trip an API key: reading reports only whether one is
   * stored, and writing is one-way into the main process.
   */
  getSettings: (): Promise<{
    provider: 'openai' | 'elevenlabs'
    openaiVoice: string
    openaiModel: string
    elevenVoiceId: string
    elevenModel: string
    hasOpenaiKey: boolean
    hasElevenKey: boolean
  }> => ipcRenderer.invoke('settings:get'),

  setSettings: (patch: Record<string, string>): Promise<unknown> =>
    ipcRenderer.invoke('settings:set', patch),

  speak: (req: {
    text: string
    provider?: 'openai' | 'elevenlabs'
    voice?: string
  }): Promise<{ audioPath: string; durationMs: number }> => ipcRenderer.invoke('tts:speak', req),

  pickExportPath: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('export:pick-output', defaultName),
  exportStart: (opts: {
    outputPath: string
    width: number
    height: number
    fps: number
    crf: number
    preset: string
    wav: ArrayBuffer | null
  }): Promise<string> => ipcRenderer.invoke('export:start', opts),
  exportFrame: (id: string, frame: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('export:frame', id, frame),
  exportFinish: (id: string): Promise<string> => ipcRenderer.invoke('export:finish', id),
  exportCancel: (id: string): Promise<void> => ipcRenderer.invoke('export:cancel', id),
}

contextBridge.exposeInMainWorld('screenflow', api)

export type ScreenFlowApi = typeof api
