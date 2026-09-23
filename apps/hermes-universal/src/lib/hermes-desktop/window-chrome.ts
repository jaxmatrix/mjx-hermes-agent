/**
 * Where this window's min / max / close sit, in the terms desktop reads.
 *
 * Electron paints the OS buttons itself (`titleBarOverlay`, the macOS traffic
 * lights) and tells the renderer how much room they take: `nativeOverlayWidth`
 * on the right for Windows/Linux, `windowButtonPosition` on the left for macOS.
 * Desktop's titlebar (`app/shell/titlebar.ts`, `app/contrib/wiring.tsx`) and the
 * pane shell's tab dodge (`components/pane-shell/geometry.ts`) pad by those two.
 *
 * Every Tauri window here is frameless on every desktop OS (`decorations:
 * false` in all three `tauri*.conf.json` and in `window.rs`), so universal draws
 * the buttons (`app/shell/window-chrome.tsx`) — and reports THEIR box through
 * the same two fields. The box is fixed in px, and the buttons are centred in
 * it, so the number below is the real reservation by construction rather than a
 * measurement that lands after the descriptor has been handed out.
 *
 * The descriptor only exists once a connection has resolved, and the buttons
 * are there from the first frame — with no backend at all, too. Desktop's
 * titlebar has an earlier source, which it prefers: Chromium's Window Controls
 * Overlay (`navigator.windowControlsOverlay`, read by
 * `use-window-controls-overlay-width.ts`). No Tauri webview has an overlay, so
 * the same box is published there as well; without it desktop's right-hand
 * cluster sits UNDER the buttons until the first connection lands.
 *
 * A leaf on purpose: the bridge's install graph may not reach a store.
 */

import type { HermesConnection } from '@/global'
import { IS_DESKTOP, IS_MAC } from '@/lib/platform'

/** Windows/Linux: the box is flush with the top-right corner, this wide. */
export const WINDOW_CHROME_WIDTH = 80

/**
 * macOS: the box starts here and is `WINDOW_CHROME_MAC_WIDTH` wide — the
 * footprint desktop already assumes for the traffic lights (its left cluster
 * starts at `x + 74`, the tab dodge ends at `x + 58`).
 */
export const WINDOW_CHROME_MAC_X = 10
export const WINDOW_CHROME_MAC_WIDTH = 58

/** Vertical centre of the macOS box, as Electron's `trafficLightPosition.y`. */
const WINDOW_CHROME_MAC_Y = 10

export type WindowChromeSide = 'left' | 'right'

export const windowChromeSide = (): WindowChromeSide => (IS_MAC ? 'left' : 'right')

/**
 * True in the windows that render desktop's root on a desktop OS: `main` and
 * `instance-<n>`, the two `window.rs` opens with no `?win=`. Every other kind
 * (tile, HUD, quick entry, wake light, activity) has its own chrome or none.
 */
export function hostsWindowChrome(): boolean {
  if (!IS_DESKTOP || typeof window === 'undefined') {
    return false
  }

  try {
    return new URLSearchParams(window.location.search).get('win') === null
  } catch {
    return false
  }
}

/** The two descriptor fields desktop's chrome pads by. */
export function windowChromeInsets(): Pick<HermesConnection, 'nativeOverlayWidth' | 'windowButtonPosition'> {
  if (!hostsWindowChrome()) {
    return { nativeOverlayWidth: 0, windowButtonPosition: null }
  }

  return windowChromeSide() === 'left'
    ? { nativeOverlayWidth: 0, windowButtonPosition: { x: WINDOW_CHROME_MAC_X, y: WINDOW_CHROME_MAC_Y } }
    : { nativeOverlayWidth: WINDOW_CHROME_WIDTH, windowButtonPosition: null }
}

/** `TITLEBAR_HEIGHT` in `app/shell/titlebar.ts`; a leaf cannot import the shell. */
const WINDOW_CHROME_BAND_HEIGHT = 34

/**
 * Publish the box as a Window Controls Overlay. Right-hand side only: the API
 * describes a titlebar area with the controls cut out of its END, and desktop
 * reads nothing from it on macOS. The geometry is a function of the viewport,
 * and desktop's hook re-measures on `resize`, so there is no event to raise.
 */
export function installWindowControlsOverlay(): void {
  if (!hostsWindowChrome() || windowChromeSide() !== 'right') {
    return
  }

  Object.defineProperty(navigator, 'windowControlsOverlay', {
    configurable: true,
    value: {
      addEventListener: () => {},
      getTitlebarAreaRect: () =>
        new DOMRect(0, 0, Math.max(0, window.innerWidth - WINDOW_CHROME_WIDTH), WINDOW_CHROME_BAND_HEIGHT),
      removeEventListener: () => {},
      visible: true
    }
  })
}
