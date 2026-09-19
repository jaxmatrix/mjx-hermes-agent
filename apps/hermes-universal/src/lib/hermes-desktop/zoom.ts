/**
 * `hermesDesktop.zoom`, over the webview's own zoom (`Webview.setZoom`).
 *
 * Electron's main process owns the level, persists it and restores it before
 * the renderer asks. Here the webview owns all three: the percent is a
 * `localStorage` key (the pre-resync one, so a chosen size survives the
 * upgrade), and it is applied when the bridge installs — a window's text size
 * must not wait for Settings, or for a store nobody imported, to be right.
 *
 * All four members or none: desktop guards the NAMESPACE (`store/zoom.ts`) and
 * then calls `get` and `onChanged` unguarded.
 *
 * `factor()` is synchronous coordinate math's input, so it reports what the
 * webview was last TOLD, never the percent still being applied.
 */

import type * as TauriWebview from '@tauri-apps/api/webview'

import { IS_DESKTOP } from '@/lib/platform'
import { readKey, writeKey } from '@/lib/storage'

type ZoomBridge = NonNullable<NonNullable<typeof window.hermesDesktop>['zoom']>
type ZoomState = Awaited<ReturnType<ZoomBridge['get']>>

const ZOOM_KEY = 'hermes.zoomPercent'

/** The range the webview lever has always been held to (`store/zoom.ts`, pre-resync). */
export const ZOOM_MIN_PERCENT = 50
export const ZOOM_MAX_PERCENT = 200

/** Desktop's shipped density (`electron/zoom.ts`, the Appearance 90% preset). A
 *  phone's text size is the OS's, so it starts at the webview's own 100. */
const DEFAULT_PERCENT = IS_DESKTOP ? 90 : 100

/** Chromium's unit, which desktop's payload carries: factor = 1.2 ^ level. */
const ZOOM_FACTOR_BASE = 1.2

const clampPercent = (percent: number): number =>
  Number.isFinite(percent) && percent > 0
    ? Math.min(ZOOM_MAX_PERCENT, Math.max(ZOOM_MIN_PERCENT, Math.round(percent)))
    : DEFAULT_PERCENT

const stateOf = (percent: number): ZoomState => ({
  level: Math.log(percent / 100) / Math.log(ZOOM_FACTOR_BASE),
  percent
})

function persistedPercent(): number {
  const raw = readKey(ZOOM_KEY)

  return raw === null ? DEFAULT_PERCENT : clampPercent(Number(raw))
}

const listeners = new Set<(state: ZoomState) => void>()

let percent = persistedPercent()
let appliedFactor = 1
/** Only the newest apply may report: a slow one must not undo a later one. */
let generation = 0

/** Imported once: the settings control can ask for several sizes in a row. */
let webviewApi: null | Promise<typeof TauriWebview> = null

/** Whether the webview took it. */
async function apply(next: number): Promise<boolean> {
  const mine = ++generation

  try {
    webviewApi ??= import('@tauri-apps/api/webview')

    await (await webviewApi).getCurrentWebview().setZoom(next / 100)
  } catch {
    // An engine without the lever. The text stays the size it is, and
    // `factor()` and the settings control keep saying so.
    return false
  }

  if (mine === generation) {
    appliedFactor = next / 100
  }

  return true
}

let restored: null | Promise<unknown> = null

/** The persisted size, applied once per window. */
function restore(): Promise<unknown> {
  restored ??= apply(percent)

  return restored
}

export const zoomBridge: ZoomBridge = {
  factor: () => appliedFactor,

  get: async () => {
    await restore()

    return stateOf(percent)
  },

  onChanged: callback => {
    listeners.add(callback)

    return () => void listeners.delete(callback)
  },

  // Applied first, then persisted and announced: `onChanged` is the only thing
  // that moves desktop's control, so a size the webview refused is never shown.
  setPercent: next => {
    const asked = clampPercent(Number(next))

    void apply(asked).then(took => {
      if (!took) {
        return
      }

      percent = asked
      writeKey(ZOOM_KEY, String(asked))

      for (const listener of [...listeners]) {
        listener(stateOf(asked))
      }
    })
  }
}

/** Electron restores zoom on window load; this is that, for the install. */
export function restoreZoom(): void {
  void restore()
}
