/**
 * Electron `windowControls` over Tauri’s window API.
 *
 * On Electron, `custom` is true only under WSLg (renderer-drawn caption
 * buttons; OS chrome owns them elsewhere). Every Tauri desktop window here is
 * frameless (`decorations: false`) and `WindowChrome` already draws min/max/
 * close, so `custom` stays false — exposing the methods still lets callers
 * that reach for the bridge (WSLg controls, tests) drive the same window.
 */

import { getCurrentWindow } from '@tauri-apps/api/window'

import { IS_DESKTOP } from '@/lib/platform'

type Bridge = NonNullable<typeof window.hermesDesktop>

const minimize: Bridge['windowControls']['minimize'] = () => {
  void getCurrentWindow()
    .minimize()
    .catch(() => undefined)
}

const toggleMaximize: Bridge['windowControls']['toggleMaximize'] = () => {
  const win = getCurrentWindow()
  void win
    .toggleMaximize()
    .then(() => win.setFocus())
    .catch(() => undefined)
}

const close: Bridge['windowControls']['close'] = () => {
  void getCurrentWindow()
    .close()
    .catch(() => undefined)
}

export const windowControlsBridge: Pick<Bridge, 'windowControls'> | Record<string, never> = IS_DESKTOP
  ? {
      windowControls: {
        custom: false,
        minimize,
        toggleMaximize,
        close
      }
    }
  : {}
