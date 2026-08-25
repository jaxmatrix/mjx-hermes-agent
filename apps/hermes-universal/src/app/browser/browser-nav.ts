/**
 * Which browser pane a navigation chord should drive.
 *
 * ⌘R must reload the PAGE when the user is in the pane and the WINDOW when they
 * are not, and a detached tile window can put a second pane on screen. So the
 * registry is keyed by element and answered by focus, the way desktop's
 * `preview-nav.ts` answers it — not by "the last one that mounted".
 *
 * Note what this canNOT do: once focus is inside the GUEST itself, the host
 * document never sees the key at all (a child webview's key events do not reach
 * Tauri). Those chords are handled by the injected guest script instead — see
 * `GUEST_INIT` in `src-tauri/src/browser/desktop.rs`.
 */

export const PREVIEW_BROWSER_ATTR = 'data-preview-browser'

export interface BrowserNavHandle {
  back: () => void
  forward: () => void
  reload: () => void
  stop: () => void
}

const panes = new Map<HTMLElement, BrowserNavHandle>()

export function registerBrowserNav(element: HTMLElement, handle: BrowserNavHandle): () => void {
  panes.set(element, handle)

  return () => {
    // Only if it is still OURS: a remount can register the replacement before
    // the old effect's cleanup runs, and deleting unconditionally would then
    // unregister the live pane.
    if (panes.get(element) === handle) {
      panes.delete(element)
    }
  }
}

/** The pane a command should go to when the user has not focused one. */
export function activeBrowserNav(): BrowserNavHandle | null {
  const focused = commandFocusedBrowser()

  if (focused) {
    return focused
  }

  let last: BrowserNavHandle | null = null

  panes.forEach(handle => {
    last = handle
  })

  return panes.size === 1 ? last : null
}

/**
 * The pane the keyboard is actually in, or `null` — which is what lets ⌘R fall
 * through to the window instead of silently reloading a page the user is not
 * looking at.
 */
export function commandFocusedBrowser(): BrowserNavHandle | null {
  if (typeof document === 'undefined') {
    return null
  }

  const active = document.activeElement

  if (!active) {
    return null
  }

  for (const [element, handle] of panes) {
    if (element === active || element.contains(active)) {
      return handle
    }
  }

  return null
}

/** Test seam. */
export function __resetBrowserNav(): void {
  panes.clear()
}
