/**
 * `hermesDesktop.themes` over Rust `marketplace_search` / `marketplace_fetch`.
 *
 * Same commands `store/marketplace.ts` already invokes directly — this bridge
 * is for call sites that still go through `window.hermesDesktop.themes`
 * (appearance settings, command palette, `themes/install.ts`).
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const searchMarketplace: Bridge['themes']['searchMarketplace'] = async query =>
  invokeNative('marketplace_search', { query: String(query ?? ''), limit: 20 })

const fetchMarketplace: Bridge['themes']['fetchMarketplace'] = async id =>
  invokeNative('marketplace_fetch', { id: String(id ?? '').trim() })

export const themesBridge: Pick<Bridge, 'themes'> = {
  themes: {
    searchMarketplace,
    fetchMarketplace
  }
}
