import { type CSSProperties, useEffect } from 'react'

import {
  WINDOW_CHROME_MAC_WIDTH,
  WINDOW_CHROME_MAC_X,
  WINDOW_CHROME_WIDTH,
  windowChromeInsets,
  windowChromeSide
} from '@/lib/hermes-desktop/window-chrome'
import { installWindowDrag } from '@/lib/window-drag'

import { TITLEBAR_HEIGHT, titlebarControlsYNudge } from './titlebar'
import { WindowControls } from './window-controls'

/**
 * What Electron's frame gives desktop's root and a frameless Tauri window does
 * not: the min / max / close buttons, and a titlebar that moves the window.
 *
 * Mounted by `app.tsx` beside desktop's root, not inside it — the buttons have
 * to be there while that root is still loading, and if it fails to. The box is
 * the one `lib/hermes-desktop/window-chrome` reports on the connection
 * descriptor, so desktop's titlebar clusters and tab strips already stand clear
 * of it, the way they stand clear of the OS buttons on Electron.
 *
 * `--z-window-chrome` is above the whole boot chain: the OS buttons float over
 * every web layer on Electron, and a window showing a full-screen connecting or
 * crash surface must still close. `pointer-events-auto` for the same reason — a
 * Radix modal switches the body's pointer events off.
 */
export function WindowChrome() {
  useEffect(() => installWindowDrag(), [])

  const left = windowChromeSide() === 'left'

  const box: CSSProperties = left
    ? {
        left: WINDOW_CHROME_MAC_X,
        // Desktop nudges its left cluster onto the traffic lights' optical
        // centre; these sit where the lights would, so they take the same nudge.
        translate: `0 ${titlebarControlsYNudge(windowChromeInsets())}`,
        width: WINDOW_CHROME_MAC_WIDTH
      }
    : { right: 0, width: WINDOW_CHROME_WIDTH }

  return (
    <div
      className="pointer-events-auto fixed top-0 z-(--z-window-chrome) flex items-center justify-center select-none"
      data-window-chrome={left ? 'left' : 'right'}
      style={{ ...box, height: TITLEBAR_HEIGHT }}
    >
      <WindowControls leading={left} />
    </div>
  )
}
