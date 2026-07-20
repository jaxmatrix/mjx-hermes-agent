import { describe, expect, it } from 'vitest'

import { BUILTIN_THEME_LIST, DEFAULT_TYPOGRAPHY, EMOJI_FALLBACK } from './presets'

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
