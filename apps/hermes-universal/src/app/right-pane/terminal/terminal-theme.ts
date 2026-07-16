import type { ITheme } from '@xterm/xterm'

import type { DesktopTerminalPalette } from '@/themes/types'

// Ported from the desktop terminal (apps/desktop/.../terminal/selection.ts).
//
// VS Code's default integrated-terminal palette (terminalColorRegistry.ts) — a
// fixed table per theme type, not luminance-derived. Light/dark diverge on
// purpose so each stays legible (e.g. mustard yellow on white). A skin only
// overrides the slots it defines (none of the built-in universal skins ship a
// terminal palette yet); `withSurface` swaps the live skin surface in for
// `background`/`cursorAccent`, and xterm's `minimumContrastRatio` (set on the
// Terminal) keeps every glyph readable against it.
const DARK_THEME: ITheme = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#cccccc',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f7866',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5'
}

const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#333333',
  cursor: '#333333',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff80',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
}

/**
 * Full xterm ITheme for the painted mode, optionally overlaid with a skin's ANSI
 * palette. `palette` fills only the slots it defines, so a partial import keeps
 * the mode defaults for the rest. `background` here is a fallback only —
 * `withSurface` swaps in the live skin surface at runtime.
 */
export function terminalTheme(mode: 'light' | 'dark', palette?: DesktopTerminalPalette): ITheme {
  const base = mode === 'dark' ? DARK_THEME : LIGHT_THEME

  if (!palette) {
    return base
  }

  const overlay = { ...base } as Record<string, string>

  for (const [slot, value] of Object.entries(palette)) {
    if (value) {
      overlay[slot] = value
    }
  }

  return overlay as ITheme
}

/**
 * Resolve `--ui-editor-surface-background` (a color-mix on the skin seed) to a
 * concrete rgb for the WebGL renderer + contrast clamp. Custom properties don't
 * resolve via `getComputedStyle`, so probe a real `background-color`. Read AFTER
 * applyTheme repaints (mount / rAF post-change) or it lags a frame behind.
 */
export function resolveSurfaceColor(fallback: string): string {
  if (typeof document === 'undefined' || !document.body) {
    return fallback
  }

  const probe = document.createElement('span')
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;background-color:var(--ui-editor-surface-background)'
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).backgroundColor
  probe.remove()

  return resolved && resolved !== 'rgba(0, 0, 0, 0)' ? resolved : fallback
}

/**
 * Bind `background` + the block-cursor glyph (`cursorAccent`) to the live skin
 * surface, leaving foreground/cursor/selection/ANSI from the base table intact.
 */
export function withSurface(theme: ITheme): ITheme {
  const surface = resolveSurfaceColor(theme.background ?? '#ffffff')

  return { ...theme, background: surface, cursorAccent: surface }
}
