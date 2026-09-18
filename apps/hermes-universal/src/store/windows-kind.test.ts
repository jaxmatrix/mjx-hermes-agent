/**
 * Desktop's window-kind predicates, answered over universal's window model
 * (MJXHRM-602).
 *
 * Two things are worth pinning. The HUD is a satellite surface here rather than
 * its own `?win=` kind, so `isHudWindow()` has to agree with `satelliteSurface()`
 * — and the predicates have to answer when they are reached through the import
 * cycle this module sits in, before its own body has run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const realLocation = window.location

function atSearch(search: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, search },
    writable: true
  })
}

const load = () => import('@/store/windows')

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation, writable: true })
  vi.resetModules()
})

describe('isHudWindow', () => {
  it('is the hud satellite, under desktop’s name', async () => {
    atSearch('?win=hud')

    const windows = await load()

    expect(windows.isHudWindow()).toBe(true)
    expect(windows.satelliteSurface()).toBe(windows.HUD_SURFACE)
  })

  it('is false for every other satellite and for a tile', async () => {
    const windows = await load()

    for (const search of ['?win=quick', '?win=wake', '?win=tile&tile=chat', '?win=activity', '']) {
      atSearch(search)
      expect(windows.isHudWindow()).toBe(false)
    }
  })
})

describe('isAuxiliaryWindow', () => {
  it('is true for tiles and satellites, false for the primary and an activity screen', async () => {
    const windows = await load()

    const cases: Array<[string, boolean]> = [
      ['', false],
      ['?win=activity', false],
      ['?win=hud', true],
      ['?win=secondary', true],
      ['?win=tile&tile=files', true]
    ]

    for (const [search, expected] of cases) {
      atSearch(search)
      expect(windows.isAuxiliaryWindow()).toBe(expected)
    }
  })
})

describe('capabilities Tauri does not have yet', () => {
  it('never reads as a browser window, and offers neither opener', async () => {
    atSearch('?win=browser&tab=t1')

    const windows = await load()

    expect(windows.isBrowserWindow()).toBe(false)
    expect(windows.canOpenBrowserWindow()).toBe(false)
    expect(windows.canOpenSessionInTerminal()).toBe(false)
    expect(await windows.openBrowserInNewWindow('t1')).toBe(false)
  })

  it('reads no profile override off a satellite URL that carries none', async () => {
    atSearch('?win=hud')

    expect((await load()).windowProfileOverride()).toBeNull()
  })
})

describe('init order', () => {
  it('answers while its own body has not run yet', async () => {
    atSearch('')

    // `@/store/windows` → `@/app/routes` → `pane-shell/tree/store` → back here:
    // entered from this module, `$layoutTree` calls the predicates before a
    // single `let`/`const` of this file is initialised.
    const windows = await load()
    const { $layoutTree } = await import('@/components/pane-shell/tree/store')

    expect(windows.isSecondaryWindow()).toBe(false)
    expect($layoutTree.get()).toBeNull()
  })
})
