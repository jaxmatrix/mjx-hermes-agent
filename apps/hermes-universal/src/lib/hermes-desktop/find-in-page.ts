/**
 * `hermesDesktop.findInPage` / `stopFindInPage` / `onFoundInPage` over Rust
 * `find_in_page` / `stop_find_in_page` + `hermes://found-in-page`.
 *
 * Primary-window search uses the portable DOM walker (`store/find-in-page.ts`).
 * This bridge keeps the Electron-shaped API for secondary windows / Linux
 * engine search and for `initFindInPageListener`.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const findInPage: Bridge['findInPage'] = async (query, options = {}) => {
  try {
    await invokeNative('find_in_page', {
      query: String(query ?? ''),
      forward: options.forward ?? true,
      findNext: options.findNext ?? false
    })
  } catch {
    // Non-Linux builds reject with unsupported_platform — the portable walker
    // owns search there; a zero count keeps the bar honest.
  }

  // Match count arrives asynchronously on `hermes://found-in-page`.
  return { count: 0 }
}

const stopFindInPage: Bridge['stopFindInPage'] = async () => {
  try {
    await invokeNative('stop_find_in_page')
  } catch {
    // Same as above — ignore on platforms without the engine binding.
  }
}

const onFoundInPage: Bridge['onFoundInPage'] = callback => {
  let stop: (() => void) | undefined
  let cancelled = false

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      // Rust emits the raw match count (u32). Electron's activeMatchOrdinal is
      // not available on WebKitGTK — report 0 and let the finder step locally.
      const unlisten = await listen<number>('hermes://found-in-page', event => {
        const count = Number(event.payload) || 0

        callback({ activeMatchOrdinal: 0, count })
      })

      if (cancelled) {
        unlisten()
      } else {
        stop = unlisten
      }
    } catch {
      // No event bus.
    }
  })()

  return () => {
    cancelled = true
    stop?.()
  }
}

export const findInPageBridge: Pick<Bridge, 'findInPage' | 'stopFindInPage' | 'onFoundInPage'> = {
  findInPage,
  stopFindInPage,
  onFoundInPage
}
