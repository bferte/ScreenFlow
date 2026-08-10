/// <reference types="vite/client" />

import type { ScreenFlowApi } from '../electron/preload'

declare global {
  interface Window {
    screenflow: ScreenFlowApi
  }

  /**
   * Chromium's non-standard desktop capture constraints. They are not in the
   * DOM lib, and the standard `MediaTrackConstraints` type rejects them.
   */
  interface DesktopCaptureConstraints {
    mandatory: {
      chromeMediaSource: 'desktop'
      chromeMediaSourceId?: string
      maxWidth?: number
      maxHeight?: number
      minFrameRate?: number
      maxFrameRate?: number
    }
  }
}

export {}
