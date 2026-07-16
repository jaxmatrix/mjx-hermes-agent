/**
 * Install user themes from external sources (pasted VS Code theme JSON or a
 * Marketplace extension). Ported from apps/desktop/src/themes/install.ts.
 *
 * The network + `.vsix` unzip runs natively in Rust (`src-tauri/src/marketplace.rs`),
 * reached from `@/store/marketplace`. Rust hands back the raw theme JSON; we
 * parse + convert + persist here so the conversion stays in one testable place.
 */

import type { DesktopTheme } from './types'
import { installUserTheme } from './user-themes'
import { convertVscodeColorTheme, parseVscodeTheme, vscodeThemeSlug } from './vscode'

/** One color theme an extension contributes (raw JSONC text). */
export interface MarketplaceThemeFile {
  label: string
  /** VS Code's `uiTheme` for this entry (vs-dark / vs / hc-black). */
  uiTheme?: string
  /** Raw theme JSON (JSONC) text, parsed + converted here. */
  contents: string
}

/** The color themes a single Marketplace extension contributes. */
export interface MarketplaceThemeResult {
  extensionId: string
  displayName: string
  themes: MarketplaceThemeFile[]
}

/** A `publisher.extension` id, e.g. `dracula-theme.theme-dracula`. */
export const MARKETPLACE_ID_RE = /^[\w-]+\.[\w-]+$/

/** Parse + convert + persist a pasted VS Code theme JSON. */
export function installVscodeThemeFromText(text: string, opts?: { label?: string; source?: string }): DesktopTheme {
  const raw = parseVscodeTheme(text)
  const { theme } = convertVscodeColorTheme(raw, opts)

  return installUserTheme(theme)
}

/**
 * Fold every color theme an extension contributes into ONE desktop theme family.
 *
 * Many extensions ship a light *and* a dark variant (GitHub, Solarized, Winter
 * is Coming…). Rather than install them as separate flat entries — which made
 * the light/dark toggle a no-op and let "install in dark mode" land on the light
 * variant — we map the first light variant onto `colors` and the first dark
 * variant onto `darkColors`. The result is a single picker entry whose light/dark
 * toggle switches between the real variants. A single-variant extension fills
 * both slots with its one palette (the toggle is a no-op, as it must be).
 */
export function buildThemeFromMarketplace(result: MarketplaceThemeResult): DesktopTheme {
  if (!result.themes.length) {
    throw new Error(`"${result.extensionId}" does not contribute any color themes.`)
  }

  const variants = result.themes.map(file => {
    const raw = parseVscodeTheme(file.contents)
    const label = file.label || raw.name || result.displayName
    const { mode, theme } = convertVscodeColorTheme(raw, { label, source: result.extensionId })

    return { mode, palette: theme.colors, terminal: theme.terminal }
  })

  const fallback = variants[0]
  const light = variants.find(variant => variant.mode === 'light') ?? fallback
  const dark = variants.find(variant => variant.mode === 'dark') ?? fallback

  // The terminal ANSI palette tracks the painted variant the same way colors do
  // (light → terminal, dark → darkTerminal); each falls back to the other so a
  // single-variant import still themes the terminal in both modes.
  const terminal = light.terminal ?? dark.terminal
  const darkTerminal = dark.terminal ?? light.terminal

  return {
    name: vscodeThemeSlug(result.displayName),
    label: result.displayName,
    description: `VS Code · ${result.extensionId}`,
    colors: light.palette,
    darkColors: dark.palette,
    ...(terminal ? { terminal } : {}),
    ...(darkTerminal ? { darkTerminal } : {})
  }
}
