/**
 * VS Code color-theme → DesktopTheme converter. Ported verbatim from
 * apps/desktop/src/themes/vscode.ts (the color helpers + types are identical in
 * universal). `applyTheme` derives every glass/shadcn token from a small seed
 * chain via color-mix(); this maps the ~6 load-bearing VS Code workbench keys and
 * derives the rest.
 */

import { ensureContrast, luminance, mix, normalizeHex, readableOn } from './color'
import type { DesktopTerminalPalette, DesktopTheme, DesktopThemeColors } from './types'

const ACCENT_MIN_CONTRAST = 4.5

/** The shape of a VS Code `*-color-theme.json` (only the fields we read). */
export interface VscodeColorTheme {
  name?: string
  type?: string
  include?: string
  colors?: Record<string, unknown>
  tokenColors?: unknown
}

export interface ConvertOptions {
  slug?: string
  label?: string
  source?: string
}

export interface ConvertResult {
  theme: DesktopTheme
  mode: 'light' | 'dark'
  derived: string[]
}

/** Tolerant slug: lowercase, alnum + dashes, deduped, `vsc-` namespaced. */
export function vscodeThemeSlug(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return `vsc-${base || 'theme'}`
}

/**
 * Parse a VS Code theme file. These ship as JSONC (comments + trailing commas),
 * so strip those, then parse. Throws on hard syntax errors.
 */
export function parseVscodeTheme(text: string): VscodeColorTheme {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1')
    .replace(/,(\s*[}\]])/g, '$1')

  const parsed: unknown = JSON.parse(stripped)

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Theme file is not a JSON object.')
  }

  return parsed as VscodeColorTheme
}

const isDarkType = (raw: VscodeColorTheme, background: string): boolean => {
  const type = (raw.type ?? '').toLowerCase()

  if (type.includes('light')) {
    return false
  }

  if (type === 'dark' || type === 'hc' || type === 'hc-black' || type.includes('dark')) {
    return true
  }

  return luminance(background) < 0.4
}

const ANSI_TOKENS: ReadonlyArray<readonly [keyof DesktopTerminalPalette, string]> = [
  ['black', 'terminal.ansiBlack'],
  ['red', 'terminal.ansiRed'],
  ['green', 'terminal.ansiGreen'],
  ['yellow', 'terminal.ansiYellow'],
  ['blue', 'terminal.ansiBlue'],
  ['magenta', 'terminal.ansiMagenta'],
  ['cyan', 'terminal.ansiCyan'],
  ['white', 'terminal.ansiWhite'],
  ['brightBlack', 'terminal.ansiBrightBlack'],
  ['brightRed', 'terminal.ansiBrightRed'],
  ['brightGreen', 'terminal.ansiBrightGreen'],
  ['brightYellow', 'terminal.ansiBrightYellow'],
  ['brightBlue', 'terminal.ansiBrightBlue'],
  ['brightMagenta', 'terminal.ansiBrightMagenta'],
  ['brightCyan', 'terminal.ansiBrightCyan'],
  ['brightWhite', 'terminal.ansiBrightWhite']
]

const BASE_ANSI: ReadonlyArray<keyof DesktopTerminalPalette> = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white'
]

const HEX_RE = /^#[0-9a-f]{3,8}$/i

function extractTerminalPalette(
  colors: Record<string, unknown>,
  background: string
): DesktopTerminalPalette | undefined {
  const hex = (key: string): string | undefined =>
    normalizeHex(typeof colors[key] === 'string' ? (colors[key] as string) : null, background) ?? undefined

  const palette: DesktopTerminalPalette = {}

  for (const [slot, token] of ANSI_TOKENS) {
    const value = hex(token)

    if (value) {
      palette[slot] = value
    }
  }

  if (!BASE_ANSI.every(slot => palette[slot])) {
    return undefined
  }

  const foreground = hex('terminal.foreground')
  const cursor = hex('terminalCursor.foreground') ?? hex('terminalCursor.background')

  const selection =
    typeof colors['terminal.selectionBackground'] === 'string' ? colors['terminal.selectionBackground'].trim() : ''

  if (foreground) {
    palette.foreground = foreground
  }

  if (cursor) {
    palette.cursor = cursor
  }

  if (HEX_RE.test(selection)) {
    palette.selectionBackground = selection
  }

  return palette
}

const pick = (
  colors: Record<string, unknown>,
  keys: string[],
  backdrop: string
): { key: string; value: string } | null => {
  for (const key of keys) {
    const value = normalizeHex(typeof colors[key] === 'string' ? (colors[key] as string) : null, backdrop)

    if (value) {
      return { key, value }
    }
  }

  return null
}

export function convertVscodeColorTheme(raw: VscodeColorTheme, opts: ConvertOptions = {}): ConvertResult {
  const colors = raw.colors && typeof raw.colors === 'object' ? (raw.colors as Record<string, unknown>) : null

  if (!colors) {
    throw new Error('Theme has no "colors" map — not a VS Code color theme.')
  }

  const derived: string[] = []

  const backgroundHit = pick(
    colors,
    ['editor.background', 'editorPane.background', 'editorGroup.background'],
    '#000000'
  )

  const dark = isDarkType(raw, backgroundHit?.value ?? '#1e1e1e')
  const background = backgroundHit?.value ?? (dark ? '#1e1e1e' : '#ffffff')

  if (!backgroundHit) {
    derived.push('editor.background')
  }

  const take = (keys: string[], fallback: string): string => {
    const hit = pick(colors, keys, background)

    if (hit) {
      return hit.value
    }

    derived.push(keys[0])

    return fallback
  }

  const foreground = take(['editor.foreground', 'foreground'], dark ? '#d4d4d4' : '#1f1f1f')

  const accentSource = take(
    [
      'button.background',
      'textLink.activeForeground',
      'textLink.foreground',
      'activityBarBadge.background',
      'badge.background',
      'progressBar.background',
      'pickerGroup.foreground',
      'list.highlightForeground',
      'editorLink.activeForeground',
      'focusBorder',
      'tab.activeBorder',
      'statusBarItem.remoteBackground'
    ],
    mix(foreground, background, 0.55)
  )

  const elevated = take(
    [
      'editorWidget.background',
      'dropdown.background',
      'menu.background',
      'quickInput.background',
      'editorSuggestWidget.background'
    ],
    mix(background, foreground, dark ? 0.08 : 0.05)
  )

  const card = take(
    ['sideBarSectionHeader.background', 'tab.inactiveBackground', 'editorGroupHeader.tabsBackground'],
    mix(background, foreground, dark ? 0.04 : 0.025)
  )

  const sidebar = take(
    ['sideBar.background', 'activityBar.background'],
    mix(background, foreground, dark ? 0.02 : 0.012)
  )

  const accent = ensureContrast(accentSource, sidebar, ACCENT_MIN_CONTRAST)

  const border = take(
    ['panel.border', 'editorGroup.border', 'sideBar.border', 'contrastBorder', 'widget.border', 'input.border'],
    mix(background, foreground, dark ? 0.16 : 0.14)
  )

  const input = take(
    ['input.background', 'dropdown.background', 'quickInput.background'],
    mix(background, foreground, dark ? 0.1 : 0.06)
  )

  const mutedForeground = take(
    ['descriptionForeground', 'editorLineNumber.foreground', 'tab.inactiveForeground', 'disabledForeground'],
    mix(foreground, background, 0.45)
  )

  const destructive = take(
    [
      'editorError.foreground',
      'errorForeground',
      'editorOverviewRuler.errorForeground',
      'notificationsErrorIcon.foreground'
    ],
    '#e25563'
  )

  const muted = mix(background, foreground, dark ? 0.06 : 0.04)
  const accentSoft = mix(accent, background, dark ? 0.82 : 0.88)
  const secondary = mix(accent, background, dark ? 0.72 : 0.86)

  const palette: DesktopThemeColors = {
    background,
    foreground,
    card,
    cardForeground: foreground,
    muted,
    mutedForeground,
    popover: elevated,
    popoverForeground: foreground,
    primary: accent,
    primaryForeground: readableOn(accent),
    secondary,
    secondaryForeground: foreground,
    accent: accentSoft,
    accentForeground: foreground,
    border,
    input,
    ring: accent,
    midground: accent,
    midgroundForeground: readableOn(accent),
    composerRing: accent,
    destructive,
    destructiveForeground: readableOn(destructive),
    sidebarBackground: sidebar,
    sidebarBorder: border,
    userBubble: mix(card, accent, dark ? 0.18 : 0.12),
    userBubbleBorder: border
  }

  const label = (opts.label ?? raw.name ?? 'VS Code Theme').trim()
  const slug = opts.slug ?? vscodeThemeSlug(label)
  const terminal = extractTerminalPalette(colors, background)

  return {
    derived,
    mode: dark ? 'dark' : 'light',
    theme: {
      name: slug,
      label,
      description: opts.source ? `VS Code · ${opts.source}` : 'Imported from VS Code',
      colors: palette,
      darkColors: palette,
      ...(terminal ? { terminal } : {})
    }
  }
}
