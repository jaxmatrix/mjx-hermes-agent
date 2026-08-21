/**
 * The `@hermes/plugin-sdk` specifier must resolve for a BUNDLED plugin — that is
 * the whole point of the vite alias + tsconfig path. This test imports the public
 * specifier the way a plugin does, so a broken alias fails here rather than at
 * plugin-load time in the app.
 *
 * Vitest inherits `resolve.alias` from vite.config.ts, so this covers both.
 */

import * as viaAlias from '@hermes/plugin-sdk'
import { describe, expect, it } from 'vitest'

import * as viaPath from './index'

describe('@hermes/plugin-sdk', () => {
  it('resolves to the app-internal module — one instance, not a copy', () => {
    expect(viaAlias.host).toBe(viaPath.host)
  })

  it('exposes the surface a plugin author is promised', () => {
    // Contribution areas.
    expect(viaAlias.PANES_AREA).toBe('panes')
    expect(viaAlias.STATUSBAR_AREAS.left).toBe('statusBar.left')
    expect(viaAlias.TITLEBAR_AREAS.center).toBe('titleBar.center')
    expect(viaAlias.PALETTE_AREA).toBe('palette')
    expect(viaAlias.ROUTES_AREA).toBe('routes')
    expect(viaAlias.SIDEBAR_NAV_AREA).toBe('sidebar.nav')
    expect(viaAlias.KEYBINDS_AREA).toBe('keybinds')
    expect(viaAlias.THEMES_AREA).toBe('themes')
    expect(viaAlias.COMPOSER_AREAS.top).toBeTypeOf('string')

    // Host doors.
    for (const door of ['logs', 'navigate', 'notify', 'onEvent', 'request', 'restartGateway', 'status'] as const) {
      expect(viaAlias.host[door]).toBeTypeOf('function')
    }

    // Readonly state atoms.
    for (const key of ['activeSessionId', 'cwd', 'gateway', 'model', 'profile', 'viewport'] as const) {
      expect(viaAlias.host.state[key].get).toBeTypeOf('function')
    }

    // UI kit + libs + data layer.
    for (const name of [
      'Button',
      'Dialog',
      'Checkbox',
      'Separator',
      'Popover',
      'EmptyState',
      'FadeScroll',
      'StatusDot'
    ] as const) {
      expect(viaAlias[name]).toBeTruthy()
    }

    expect(viaAlias.cn).toBeTypeOf('function')
    expect(viaAlias.compactNumber).toBeTypeOf('function')
    expect(viaAlias.haptic).toBeTypeOf('function')
    expect(viaAlias.useGrabScroll).toBeTypeOf('function')
    expect(viaAlias.useQuery).toBeTypeOf('function')
    expect(viaAlias.queryClient).toBeTruthy()
    expect(viaAlias.atom).toBeTypeOf('function')
    expect(viaAlias.useValue).toBeTypeOf('function')
    expect(viaAlias.usePluginI18n).toBeTypeOf('function')
    expect(viaAlias.icons.Plug).toBeTruthy()
  })

  // MJXHRM-477 → MJXHRM-455. The accent picker plugin lives on desktop and can
  // only be delivered here once the plugin host grows an in-tree door (455);
  // this is the surface it will import when it arrives, pinned now so the
  // exports can't quietly rot in the meantime. The names are exactly desktop's
  // `plugins/accent/{plugin,picker}.tsx` import lists.
  it('carries the theme surface the accent picker needs', () => {
    for (const name of [
      '$accentOverride',
      'setAccentOverride',
      'contrastRatio',
      'hexToOklch',
      'maxChroma',
      'oklchToHex',
      'oklchToSrgb255',
      'retintTheme',
      'themeHue',
      'useTheme'
    ] as const) {
      expect(viaAlias[name], name).toBeTruthy()
    }

    // Not just present — the same module instance the app paints from, or the
    // plugin would drive a second, invisible atom.
    expect(viaAlias.$accentOverride).toBe(viaPath.$accentOverride)
    expect(viaAlias.$accentOverride.get()).toBeNull()
  })

  it('reports the live viewport rect', () => {
    const viewport = viaAlias.host.state.viewport.get()

    expect(viewport).toEqual({
      height: window.innerHeight,
      narrow: expect.any(Boolean),
      width: window.innerWidth
    })
  })

  it('rejects host.request when the gateway is not connected', async () => {
    await expect(viaAlias.host.request('sessions.list')).rejects.toThrow(/not connected/i)
  })
})
