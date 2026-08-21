import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setAccentOverride } from './accent-override'
import { __resetBackendSkinSync, ingestBackendSkin } from './backend-sync'
import { hexToOklch, hueDelta } from './color'
import { $mode, ThemeProvider, useTheme } from './context'
import { nousTheme } from './presets'
import { BUILTIN_THEME_LIST } from './presets'
import { retintTheme } from './retint'

function Harness() {
  const { themeName, resolvedMode, setMode, setTheme } = useTheme()

  return (
    <div>
      <span data-testid="state">{`${themeName}:${resolvedMode}`}</span>
      <button onClick={() => setMode('dark')}>dark</button>
      <button onClick={() => setMode('light')}>light</button>
      <button onClick={() => setTheme('nous')}>nous</button>
      <button onClick={() => setTheme('ember')}>ember</button>
    </div>
  )
}

const root = () => document.documentElement

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    root().className = ''
    root().removeAttribute('style')
  })
  afterEach(() => localStorage.clear())

  it('paints seeds onto :root and defaults to the nous skin', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
    // jsdom has no matchMedia, so system resolves to light.
    expect(screen.getByTestId('state')).toHaveTextContent('nous:light')
    expect(root().style.getPropertyValue('--theme-primary').toLowerCase()).toBe('#0053fd')
    expect(root().classList.contains('dark')).toBe(false)
  })

  it('toggles the .dark class and repaints seeds on mode change', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )

    fireEvent.click(screen.getByText('dark'))
    expect(root().classList.contains('dark')).toBe(true)
    expect(root().dataset.hermesMode).toBe('dark')
    // Dark nous foreground is a light color (not the light-mode #17171a).
    expect(root().style.getPropertyValue('--theme-foreground')).not.toBe('#17171a')
    expect(localStorage.getItem('hermes.mode')).toBe('dark')

    fireEvent.click(screen.getByText('light'))
    expect(root().classList.contains('dark')).toBe(false)
  })

  it('switches skin and persists it', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
    fireEvent.click(screen.getByText('ember'))
    expect(screen.getByTestId('state')).toHaveTextContent('ember:')
    expect(localStorage.getItem('hermes.skin')).toBe('ember')
    expect(root().dataset.hermesTheme).toBe('ember')
  })

  it('writes the skin font tokens onto :root', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
    // nous inherits Courier Prime for mono; the bundled Segoe/JetBrains stacks
    // seed sans + the mono fallback. (Click nous explicitly — the persistent
    // skin atom carries the prior test's selection across cases.)
    fireEvent.click(screen.getByText('nous'))
    expect(root().style.getPropertyValue('--dt-font-sans')).toContain('Segoe WPC')
    expect(root().style.getPropertyValue('--dt-font-mono')).toContain('Courier Prime')

    fireEvent.click(screen.getByText('ember'))
    expect(root().style.getPropertyValue('--dt-font-mono')).toContain('IBM Plex Mono')
  })

  it('never injects an external web-font stylesheet (all faces are bundled)', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
    fireEvent.click(screen.getByText('ember'))
    fireEvent.click(screen.getByText('nous'))
    // Every mono face is self-hosted via @font-face; no runtime <link> fetch.
    expect(document.querySelector('link[data-hermes-theme-font]')).toBeNull()
  })
})

// The live-authoring loop: Hermes writes/edits one skin file and every surface
// repaints. An in-place edit keeps the NAME — only the palette moves.
const bloomberg = (foreground: string) => ({
  name: 'bloomberg',
  colors: { background: '#000000', ui_text: foreground, ui_accent: '#ff8000' }
})

const cssVar = (name: string) => root().style.getPropertyValue(name)

describe('ThemeProvider ← backend skin sync', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetBackendSkinSync()
  })

  afterEach(cleanup)

  it('applies an activated backend skin', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: true }))

    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')
    expect(cssVar('--theme-background-seed')).toBe('#000000')
  })

  it('repaints an in-place edit of the ACTIVE skin (same name, new palette)', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: true }))
    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')

    // Recolor the same skin file. The same-name apply guard correctly no-ops
    // (that's what protects a manual pick from snapping back), so the repaint
    // must come from the registry update reaching the active theme derivation.
    act(() => ingestBackendSkin(bloomberg('#ff2d95'), { apply: true }))
    expect(cssVar('--theme-foreground')).toBe('#ff2d95')
  })

  it('does not repaint an edit to an INACTIVE skin', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: true }))

    // A different skin registered without apply (e.g. seeded on reconnect)
    // must not touch the painted theme.
    act(() =>
      ingestBackendSkin({ name: 'forest', colors: { background: '#001100', ui_text: '#66ff66' } }, { apply: false })
    )
    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')
  })
})

// Painting each family in each appearance, and reading what actually landed on
// :root. The source-level guard (presets.test.ts) proves the palettes are
// literals; this proves the PAINT is complete — a family that resolves fewer
// vars than the default skin leaves whatever the previous theme wrote in place,
// which is how a half-applied theme ships looking almost right.
function Painter({ mode, name }: { mode: 'dark' | 'light'; name: string }) {
  const { setMode, setTheme } = useTheme()

  useEffect(() => {
    setTheme(name)
    setMode(mode)
  }, [mode, name, setMode, setTheme])

  return null
}

/** Every custom property currently set inline on :root, name → value. */
function paintedVars(): Record<string, string> {
  const style = root().style
  const out: Record<string, string> = {}

  for (let i = 0; i < style.length; i += 1) {
    const name = style.item(i)

    if (name.startsWith('--')) {
      out[name] = style.getPropertyValue(name)
    }
  }

  return out
}

describe('every builtin family paints a complete theme, in both appearances', () => {
  beforeEach(() => {
    localStorage.clear()
    root().className = ''
    root().removeAttribute('style')
  })
  afterEach(cleanup)

  const paint = (name: string, mode: 'dark' | 'light') => {
    render(
      <ThemeProvider>
        <Painter mode={mode} name={name} />
      </ThemeProvider>
    )

    return paintedVars()
  }

  const cases = BUILTIN_THEME_LIST.flatMap(theme =>
    (['light', 'dark'] as const).map(mode => ({ mode, name: theme.name }))
  )

  it.each(cases)('$name/$mode paints under its own name, every var a literal', ({ mode, name }) => {
    // The reference set: whatever the default skin resolves. A hard-coded list
    // would only re-state applyTheme; comparing families to each other catches
    // the real failure, which is one family resolving FEWER vars than the rest.
    // `setProperty(k, '')` removes the property outright, so an unresolved slot
    // shows up here as a missing key — never as an empty string — and leaves
    // whatever the previous theme painted in force.
    const expected = Object.keys(paint('nous', 'light')).sort()

    cleanup()
    root().removeAttribute('style')

    const vars = paint(name, mode)

    expect(Object.keys(vars).sort()).toEqual(expected)

    // A family registered under a key that doesn't match its own `name` paints
    // the DEFAULT skin instead — silently, and looking almost right.
    expect(root().dataset.hermesTheme).toBe(name)

    for (const [key, value] of Object.entries(vars)) {
      expect(value, key).not.toBe('')

      // Fonts and the numeric mix knobs are not colours; everything else is a
      // seed and must be something WebKitGTK resolves without `color-mix()` or
      // `oklch(from …)` relative-colour syntax.
      if (!key.startsWith('--dt-font') && !key.startsWith('--theme-mix') && !key.startsWith('--noise')) {
        expect(value, key).not.toMatch(/color-mix\(|oklch\(from|light-dark\(/)
      }
    }
  })
})

describe('accent override', () => {
  const ROSE = '#e11d48'

  beforeEach(() => {
    localStorage.clear()
    root().className = ''
    root().removeAttribute('style')
  })

  afterEach(() => {
    setAccentOverride(null)
    cleanup()
  })

  // The painted seed is the override adapted to nous's own sidebar (seedFor
  // clamps it to AA), not the raw hex — so compare against what retintTheme
  // itself produces rather than re-deriving it here.
  const ROSE_ON_NOUS = retintTheme(nousTheme, ROSE).colors.primary.toLowerCase()

  const paintNous = () =>
    act(() => {
      render(
        <ThemeProvider>
          <Painter mode="light" name="nous" />
        </ThemeProvider>
      )
    })

  const primary = () => root().style.getPropertyValue('--theme-primary').toLowerCase()

  it('repaints the accent family without touching the chrome', () => {
    paintNous()

    const chromeBefore = root().style.getPropertyValue('--theme-background-seed')

    expect(primary()).toBe('#0053fd')

    act(() => setAccentOverride(ROSE))

    expect(primary()).toBe(ROSE_ON_NOUS)
    expect(ROSE_ON_NOUS).not.toBe('#0053fd')
    // The neutrals are the app's surface, not its brand.
    expect(root().style.getPropertyValue('--theme-background-seed')).toBe(chromeBefore)
    // The mixed surfaces have to follow the seed, or the theme is half-retinted.
    expect(root().style.getPropertyValue('--theme-accent-soft')).not.toBe('#dfe8ff')
  })

  it('never persists — nothing on disk carries the override', () => {
    paintNous()
    act(() => setAccentOverride(ROSE))

    const stored = Object.keys(localStorage).map(key => `${key}=${localStorage.getItem(key)}`)

    expect(stored.join('|').toLowerCase()).not.toContain(ROSE)
  })

  it('restores the authored palette when cleared', () => {
    paintNous()
    act(() => setAccentOverride(ROSE))
    act(() => setAccentOverride(null))

    expect(primary()).toBe('#0053fd')
  })

  it('ignores a half-typed hex rather than blanking the theme', () => {
    paintNous()
    act(() => setAccentOverride(ROSE))
    act(() => setAccentOverride('#e1'))

    expect(primary()).toBe(ROSE_ON_NOUS)
  })
})

// MJXHRM-497. The finished-session dot used to be a fixed green, so eight of
// them sat in the sidebar fighting whatever palette was on.
describe('--ui-success follows the accent', () => {
  const EMERALD_HUE = 162

  beforeEach(() => {
    localStorage.clear()
    root().className = ''
    root().removeAttribute('style')
  })
  afterEach(cleanup)

  const successHue = (name: string) => {
    act(() => {
      render(
        <ThemeProvider>
          <Painter mode="light" name={name} />
        </ThemeProvider>
      )
    })

    const value = root().style.getPropertyValue('--ui-success')

    expect(value, '--ui-success is painted').toMatch(/^#[0-9a-f]{6}$/i)

    return hexToOklch(value)!.h
  }

  it('bends toward a blue accent, without becoming it', () => {
    const hue = successHue('nous')

    expect(Math.abs(hueDelta(EMERALD_HUE, hue))).toBeGreaterThan(5)
    // Still a green: "done" and "running" must not collapse into one colour.
    expect(Math.abs(hueDelta(hue, hexToOklch('#0053fd')!.h))).toBeGreaterThan(30)
  })

  it('barely moves under an accent that is already green', () => {
    cleanup()
    root().removeAttribute('style')

    expect(Math.abs(hueDelta(EMERALD_HUE, successHue('github')))).toBeLessThan(6)
  })
})

// bd853747bb on desktop: a fresh profile follows the OS. Defaulting to `light`
// meant someone whose desktop is dark got a white window on first launch and
// had to go find the setting. Universal has always defaulted to `system`, so
// this is the regression guard for a default that would flip silently.
describe('a fresh profile follows the OS', () => {
  beforeEach(() => {
    localStorage.clear()
    root().className = ''
    root().removeAttribute('style')
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'matchMedia')
  })

  const pretendOsIs = (scheme: 'dark' | 'light') => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        addEventListener: () => {},
        matches: query.includes('prefers-color-scheme: dark') && scheme === 'dark',
        removeEventListener: () => {}
      })
    })
  }

  it('starts on `system` rather than a fixed appearance', async () => {
    // A fresh module against empty storage — the persisted atom has already been
    // written by the cases above, so only a new instance sees the real default.
    vi.resetModules()

    const fresh = await import('./context')

    expect(fresh.$mode.get()).toBe('system')
  })

  it.each(['dark', 'light'] as const)('paints %s when the OS says so', scheme => {
    pretendOsIs(scheme)
    act(() => $mode.set('system'))

    act(() => {
      render(
        <ThemeProvider>
          <div />
        </ThemeProvider>
      )
    })

    expect(root().classList.contains('dark')).toBe(scheme === 'dark')
  })
})
