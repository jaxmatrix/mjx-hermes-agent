import { describe, expect, it } from 'vitest'

import { hexToOklch } from './color'
import { BUILTIN_THEME_LIST, BUILTIN_THEMES, DEFAULT_TYPOGRAPHY, EMOJI_FALLBACK } from './presets'
import type { DesktopThemeColors } from './types'

// #40364: none of the UI text/mono fonts carry emoji glyphs, so every font
// stack must end with a color-emoji fallback or emoji render as tofu on
// platforms whose default font lacks them (e.g. Linux).
describe('theme typography emoji fallback (#40364)', () => {
  const stacks: Array<[string, string]> = [
    ['DEFAULT_TYPOGRAPHY.fontSans', DEFAULT_TYPOGRAPHY.fontSans],
    ['DEFAULT_TYPOGRAPHY.fontMono', DEFAULT_TYPOGRAPHY.fontMono],
    // A theme may override only fontMono (fontSans then falls back to the
    // default, which already carries the emoji stack), so skip undefined.
    ...BUILTIN_THEME_LIST.flatMap(theme =>
      (
        [
          [`${theme.name}.fontSans`, theme.typography?.fontSans],
          [`${theme.name}.fontMono`, theme.typography?.fontMono]
        ] as Array<[string, string | undefined]>
      ).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  ]

  it.each(stacks)('%s includes a color-emoji font', (_label, stack) => {
    expect(stack).toMatch(/Apple Color Emoji|Segoe UI Emoji|Noto Color Emoji|(^|,\s*)emoji\b/)
  })

  it('EMOJI_FALLBACK lists the major platform emoji fonts', () => {
    expect(EMOJI_FALLBACK).toContain('Apple Color Emoji')
    expect(EMOJI_FALLBACK).toContain('Segoe UI Emoji')
    expect(EMOJI_FALLBACK).toContain('Noto Color Emoji')
  })
})

// The Tauri webviews are NOT Chromium: WebKitGTK (Linux) and Android WebView
// have none of the Segoe/SF families, and WebKitGTK resolves neither
// `system-ui` nor `-webkit-system-ui` (both measure identical to plain
// `sans-serif` there). A stack whose only real entries are those tokens renders
// as the OS default everywhere off Windows/macOS — which is exactly how the UI
// shipped as Noto Sans. Guard both ends of every stack.
describe('theme typography resolves off Chromium', () => {
  // A packed face must outrank `system-ui` and the generic, or Linux/Android
  // render whatever the host defaults to — the bug that shipped as "everything
  // is Noto Sans". The native SF/Segoe names stay ahead of it on purpose so
  // macOS/Windows keep rendering exactly what Electron desktop renders.
  it('the default sans stack reaches a packed face before the host default', () => {
    const stack = DEFAULT_TYPOGRAPHY.fontSans
    expect(stack).toContain('"Inter"')
    expect(stack.indexOf('"Inter"')).toBeLessThan(stack.indexOf('system-ui'))
    expect(stack.indexOf('"Inter"')).toBeLessThan(stack.indexOf('sans-serif'))
  })

  // Collapse is the wordmark face. If it ever leads the UI stack, every label
  // and message renders in the logo font (tried, reverted).
  it('keeps the wordmark face out of the sans stack', () => {
    expect(DEFAULT_TYPOGRAPHY.fontSans).not.toContain('Collapse')
  })

  it('the default mono stack names the bundled mono face', () => {
    expect(DEFAULT_TYPOGRAPHY.fontMono).toContain('"JetBrains Mono"')
  })

  // WebKitGTK maps `ui-monospace` to the default SANS face, so it must never
  // outrank a concrete monospace family.
  it('keeps ui-monospace behind the concrete mono families', () => {
    const stack = DEFAULT_TYPOGRAPHY.fontMono
    expect(stack.indexOf('ui-monospace')).toBeGreaterThan(stack.indexOf('"JetBrains Mono"'))
  })

  it.each([
    ['fontSans', DEFAULT_TYPOGRAPHY.fontSans, /(^|,\s*)sans-serif\s*(,|$)/],
    ['fontMono', DEFAULT_TYPOGRAPHY.fontMono, /(^|,\s*)monospace\s*(,|$)/]
  ])('%s terminates in a real generic family', (_label, stack, generic) => {
    expect(stack).toMatch(generic)
  })
})

// The four families that landed with the OKLCH layer are converter output, and
// the OKLCH layer only reads plain hex. Two things break at once if a palette
// carries a CSS *function* instead of a literal (which is how `nous` used to
// build its accent surfaces):
//
//   1. `hexToOklch` returns null for it, so `retintTheme` silently half-applies
//      — the seed slots move and the mixed surfaces don't.
//   2. WebKitGTK (and the Android WebView) do not resolve every colour function
//      Chromium does, so the value can paint as nothing at all.
//
// So: every colour slot of every builtin, in both appearances, is a literal the
// engine can read. This is the "resolves every var, both modes" guard — every
// var `applyTheme` writes comes from one of these slots.
describe('builtin palettes are literals the colour engine can read', () => {
  const cases = BUILTIN_THEME_LIST.flatMap(theme =>
    (
      [
        { appearance: 'light', colors: theme.colors },
        { appearance: 'dark', colors: theme.darkColors }
      ] as const
    )
      .filter(entry => entry.colors !== undefined)
      .map(entry => ({ appearance: entry.appearance, colors: entry.colors as DesktopThemeColors, name: theme.name }))
  )

  it.each(cases)('$name/$appearance is every slot as #rrggbb', ({ colors }) => {
    for (const [slot, value] of Object.entries(colors)) {
      expect(value, slot).toMatch(/^#[0-9a-f]{6}$/i)
      expect(hexToOklch(value as string), slot).not.toBeNull()
    }
  })

  // Not a count for its own sake: the ten are what the palette, the theme
  // picker and `/skin` all enumerate, and a family that fails to register is
  // invisible rather than broken.
  it('registers all ten families under unique names', () => {
    expect(BUILTIN_THEME_LIST.map(theme => theme.name).sort()).toEqual([
      'catppuccin',
      'cyberpunk',
      'ember',
      'everforest',
      'github',
      'midnight',
      'mono',
      'nous',
      'slate',
      'solarized'
    ])
  })

  // The five palette-bearing families are converted from two-appearance VS Code
  // themes and must carry both, or "GitHub dark" is a synthesised guess rather
  // than upstream's actual dark palette. The five older skins deliberately ship
  // one palette and let the engine synthesise the other side.
  it.each(['nous', 'github', 'catppuccin', 'everforest', 'solarized'])(
    '%s ships upstream\u2019s own dark palette',
    name => {
      expect(BUILTIN_THEMES[name].darkColors).toBeDefined()
    }
  )
})
