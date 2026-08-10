import { screen } from 'electron'
import type {
  ClickEvent,
  CursorSample,
  DisplayInfo,
  MouseButton,
  Telemetry,
} from '../src/types/telemetry'

/**
 * uiohook-napi ships prebuilt binaries but can still fail to load on locked
 * down machines. Clicks are a nice-to-have; cursor tracking is not, so we
 * degrade gracefully instead of taking the whole app down.
 */
type UiohookModule = {
  uIOhook: {
    on(event: 'mousedown' | 'mouseup', cb: (e: { x: number; y: number; button: number }) => void): void
    removeAllListeners(): void
    start(): void
    stop(): void
  }
}

let uiohook: UiohookModule['uIOhook'] | null = null
let uiohookError: string | null = null

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  uiohook = (require('uiohook-napi') as UiohookModule).uIOhook
} catch (err) {
  uiohookError = err instanceof Error ? err.message : String(err)
}

const BUTTON_MAP: Record<number, MouseButton> = { 1: 'left', 2: 'middle', 3: 'right' }

const SAMPLE_HZ = 60

export function describeDisplay(displayId: number): DisplayInfo {
  const all = screen.getAllDisplays()
  const display = all.find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
  const { x, y, width, height } = display.bounds
  return {
    id: display.id,
    x,
    y,
    width,
    height,
    scaleFactor: display.scaleFactor,
    pixelWidth: Math.round(width * display.scaleFactor),
    pixelHeight: Math.round(height * display.scaleFactor),
  }
}

class MouseTracker {
  private timer: NodeJS.Timeout | null = null
  private startedAt = 0
  private display: DisplayInfo | null = null
  private cursor: CursorSample[] = []
  private clicks: ClickEvent[] = []
  private hookRunning = false

  get isRecording() {
    return this.timer !== null
  }

  /** Maps a global DIP point into 0..1 within the tracked display. */
  private normalise(x: number, y: number) {
    const d = this.display!
    return {
      nx: (x - d.x) / d.width,
      ny: (y - d.y) / d.height,
    }
  }

  private onMouseEvent = (pressed: boolean) => (e: { x: number; y: number; button: number }) => {
    if (!this.display) return
    const { nx, ny } = this.normalise(e.x, e.y)
    this.clicks.push({
      t: Date.now() - this.startedAt,
      x: e.x,
      y: e.y,
      nx,
      ny,
      button: BUTTON_MAP[e.button] ?? 'left',
      pressed,
    })
  }

  start(displayId: number): { startedAt: number; clicksAvailable: boolean } {
    if (this.timer) this.stop()

    this.display = describeDisplay(displayId)
    this.startedAt = Date.now()
    this.cursor = []
    this.clicks = []

    // Poll the cursor. Electron gives no positional event stream, and polling
    // at 60 Hz costs far less than the screen capture running alongside it.
    this.timer = setInterval(() => {
      const p = screen.getCursorScreenPoint()
      const { nx, ny } = this.normalise(p.x, p.y)
      this.cursor.push({ t: Date.now() - this.startedAt, x: p.x, y: p.y, nx, ny })
    }, 1000 / SAMPLE_HZ)

    if (uiohook) {
      try {
        uiohook.on('mousedown', this.onMouseEvent(true))
        uiohook.on('mouseup', this.onMouseEvent(false))
        uiohook.start()
        this.hookRunning = true
      } catch (err) {
        uiohookError = err instanceof Error ? err.message : String(err)
        this.hookRunning = false
      }
    }

    return { startedAt: this.startedAt, clicksAvailable: this.hookRunning }
  }

  stop(): Telemetry {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.hookRunning && uiohook) {
      try {
        uiohook.removeAllListeners()
        uiohook.stop()
      } catch {
        /* the hook is already down; nothing to clean up */
      }
    }

    const telemetry: Telemetry = {
      version: 1,
      startedAt: this.startedAt,
      duration: this.startedAt ? Date.now() - this.startedAt : 0,
      sampleHz: SAMPLE_HZ,
      display: this.display ?? describeDisplay(screen.getPrimaryDisplay().id),
      cursor: this.cursor,
      clicks: this.clicks,
      clicksAvailable: this.hookRunning,
    }

    this.hookRunning = false
    return telemetry
  }
}

export const mouseTracker = new MouseTracker()
export const globalHookError = () => uiohookError
