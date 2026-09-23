/**
 * Browser pop-out over Rust `open_browser_window` +
 * `hermes://browser-window-closed` — Electron `hermes:window:openBrowser` /
 * `hermes:browser-popout:closed`.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const openBrowserWindow: NonNullable<Bridge['openBrowserWindow']> = async tabId => {
  const id = String(tabId ?? '').trim()

  if (!id) {
    return { ok: false, error: 'invalid-tab-id' }
  }

  try {
    await invokeNative('open_browser_window', { tabId: id })

    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const onBrowserPopoutClosed: NonNullable<Bridge['onBrowserPopoutClosed']> = callback => {
  let stop: (() => void) | undefined
  let cancelled = false

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const unlisten = await listen<string>('hermes://browser-window-closed', event => {
        const tabId = String(event.payload ?? '').trim()

        if (tabId) {
          callback(tabId)
        }
      })

      if (cancelled) {
        unlisten()
      } else {
        stop = unlisten
      }
    } catch {
      // No event bus (plain-browser vitest).
    }
  })()

  return () => {
    cancelled = true
    stop?.()
  }
}

export const browserWindowBridge: Pick<Bridge, 'openBrowserWindow' | 'onBrowserPopoutClosed'> = {
  openBrowserWindow,
  onBrowserPopoutClosed
}
