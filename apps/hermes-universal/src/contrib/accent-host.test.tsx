/**
 * The accent picker AT UNIVERSAL'S IN-TREE HOST BOUNDARY (MJXHRM-455).
 *
 * Same shape as `kanban-host.test.tsx` (MJXHRM-461), for the same reason and a
 * different door. `sdk/alias.test.ts` already pins the ten SDK names this plugin
 * imports, which is what made MJXHRM-477's verdict "the gap is the DOOR, not the
 * exports" — so what is NOT proved anywhere is that the door works: that
 * `src/plugins/*` is globbed, that the plugin registers through the real
 * `createPluginContext` into the real registry, that its contributions land in
 * areas this app actually renders, and that unloading it clears the override it
 * set.
 *
 * Nothing is stubbed. The picker is the shipping file, the registry is the
 * shipping registry, and `$accentOverride` is the atom the theme paints from.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PALETTE_AREA } from '@/app/command-palette/contrib'
import { STATUSBAR_AREAS } from '@/app/contrib/surfaces'
import { I18nProvider } from '@/i18n'
import accentPlugin from '@/plugins/accent/plugin'
import { ThemeProvider } from '@/themes'
import { $accentOverride, setAccentOverride } from '@/themes/accent-override'

import { createPluginContext } from './plugin'
import { registry } from './registry'

let dispose: (() => void) | null = null

/** Register it exactly the way `discoverBundledPlugins()` does. */
function registerAccent() {
  const disposers: (() => void)[] = []
  accentPlugin.register(createPluginContext(accentPlugin.id, fn => disposers.push(fn)))

  dispose = () => disposers.forEach(fn => fn())
}

const contribution = (area: string, localId: string) =>
  registry.getArea(area).find(c => c.id === `accent:${localId}`)

beforeEach(() => {
  setAccentOverride(null)
  registerAccent()
})

afterEach(() => {
  cleanup()
  dispose?.()
  dispose = null
  setAccentOverride(null)
})

describe('the in-tree accent plugin', () => {
  it('ships OFF by default — it is an authoring tool, not a setting', () => {
    // MJXHRM-461 established that `defaultEnabled: false` is a design choice and
    // not a "never rendered" bug. Desktop's posture, verbatim.
    expect(accentPlugin.defaultEnabled).toBe(false)
  })

  it('lands its contributions in areas universal actually hosts', () => {
    // statusBar.right → app/contrib/surfaces.tsx, palette →
    // app/command-palette/contrib.ts. Registering into an area nothing renders
    // is the "loaded but never rendered" failure the door exists to avoid.
    expect(contribution(STATUSBAR_AREAS.right, 'picker')).toBeDefined()
    expect(contribution(PALETTE_AREA, 'reset')?.data).toMatchObject({ id: 'accent.reset' })
    expect(contribution(PALETTE_AREA, 'copy')?.data).toMatchObject({ id: 'accent.copy' })
  })

  it('stamps the host’s provenance rather than trusting the plugin to', () => {
    expect(contribution(STATUSBAR_AREAS.right, 'picker')?.source).toBe('plugin:accent')
  })

  it('renders its statusbar trigger through the real host', () => {
    const node = contribution(STATUSBAR_AREAS.right, 'picker')

    expect(node?.render).toBeTypeOf('function')

    render(
      <I18nProvider>
        <ThemeProvider>{node!.render!()}</ThemeProvider>
      </I18nProvider>
    )

    // The trigger always shows the painted accent as a hex — never a word — so
    // the label cannot change width mid-drag. Reading one back proves the
    // component resolved `useTheme()` through the SDK's live module instance.
    expect(screen.getByTitle('Accent color (dev)').textContent).toMatch(/#[0-9a-f]{6}/i)
  })

  it('drives the SAME atom the app paints from', () => {
    const reset = contribution(PALETTE_AREA, 'reset')?.data as { run: () => void }

    setAccentOverride('#0053fd')
    expect($accentOverride.get()).toBe('#0053fd')

    reset.run()
    expect($accentOverride.get()).toBeNull()
  })

  // The override is a scratch value, not a setting. Without this, disabling the
  // plugin would strand a colour with no control left to clear it.
  it('clears the override when it is unloaded', () => {
    setAccentOverride('#bf3989')

    dispose?.()
    dispose = null

    expect($accentOverride.get()).toBeNull()
  })
})
