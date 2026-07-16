/**
 * VS Code Marketplace theme search + install, over the native Rust commands
 * (`marketplace_search` / `marketplace_fetch` in `src-tauri/src/marketplace.rs`).
 *
 * Mirrors the desktop's `window.hermesDesktop.themes` surface: the network +
 * `.vsix` unzip run natively (no CORS, and the payload is a binary zip), and the
 * conversion + persistence happens client-side in `@/themes/install`. Off Tauri
 * (the plain web build) there's no bridge, so search yields nothing and install
 * reports it's unavailable.
 */

import { IS_TAURI } from '@/lib/platform'
import { buildThemeFromMarketplace, type MarketplaceThemeResult } from '@/themes/install'
import type { DesktopTheme } from '@/themes/types'
import { installUserTheme } from '@/themes/user-themes'

/** A lightweight Marketplace card (no download). */
export interface MarketplaceSearchItem {
  extensionId: string
  displayName: string
  publisher: string
  description: string
  installs: number
}

/**
 * Search the Marketplace for color-theme extensions. Empty off Tauri; a failed
 * fetch rejects so the caller (react-query) can surface an error state.
 */
export async function searchMarketplace(query: string): Promise<MarketplaceSearchItem[]> {
  if (!IS_TAURI) {
    return []
  }

  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<MarketplaceSearchItem[]>('marketplace_search', { query, limit: 20 })
}

/**
 * Download a Marketplace extension, convert the theme family it contributes, and
 * install it. Returns the single installed theme.
 */
export async function installFromMarketplace(id: string): Promise<DesktopTheme> {
  if (!IS_TAURI) {
    throw new Error('Marketplace install is only available in the app.')
  }

  const { invoke } = await import('@tauri-apps/api/core')
  const result = await invoke<MarketplaceThemeResult>('marketplace_fetch', { id: id.trim() })

  return installUserTheme(buildThemeFromMarketplace(result))
}
