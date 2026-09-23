/**
 * Keeps the webview's own context menu out of a window that renders desktop's
 * root.
 *
 * Desktop's `AppContextMenu` never calls `preventDefault()` on `contextmenu`:
 * Chromium raises Electron's main-process `context-menu` event (its spellcheck
 * and image source) only for an unprevented gesture, and with no `Menu.popup`
 * anywhere "default" there means no menu at all. WebKitGTK, WKWebView and
 * WebView2 each pop their OWN menu for an unprevented gesture, so on Tauri the
 * two would open side by side. Desktop's file cannot be edited; this cancels
 * the gesture around it.
 *
 * Nothing in desktop's window wants the native menu — editables, selections,
 * links, images and the terminal all get desktop's — so the rule has one
 * exception, and it is about ORDER rather than ownership. A Radix
 * `ContextMenu.Trigger` composes its handler with a `defaultPrevented` check and
 * stands down for a gesture that is already cancelled, so inside one the cancel
 * is left to Radix (which always makes it), and whatever is still uncancelled
 * when the event has finished bubbling — a disabled trigger — is cancelled
 * there. Desktop's listener stops propagation for everything else, which is why
 * the bubble listener alone would not do.
 *
 * Universal's other windows need none of this: their coordinator
 * (`app/context-menu/coordinator.tsx`) cancels what it opens.
 *
 * DEV BUILDS: Shift + right-click is the webview's own menu and nothing else,
 * which is where "Inspect Element" lives. Armed from `boot.ts`, so it is the
 * first capture listener on `window` and can keep the gesture from desktop's.
 */

import { RADIX_TRIGGER_SELECTOR } from '@/app/context-menu/markers'

const wantsInspector = (event: MouseEvent): boolean => import.meta.env.DEV && event.shiftKey

export function installNativeContextMenuGuard(): () => void {
  const onCapture = (event: MouseEvent): void => {
    if (wantsInspector(event)) {
      event.stopImmediatePropagation()

      return
    }

    const element = event.target instanceof Element ? event.target : null

    if (!element?.closest(RADIX_TRIGGER_SELECTOR)) {
      event.preventDefault()
    }
  }

  const onBubble = (event: MouseEvent): void => event.preventDefault()

  window.addEventListener('contextmenu', onCapture, true)
  window.addEventListener('contextmenu', onBubble)

  return () => {
    window.removeEventListener('contextmenu', onCapture, true)
    window.removeEventListener('contextmenu', onBubble)
  }
}
