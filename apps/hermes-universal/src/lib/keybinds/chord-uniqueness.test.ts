/**
 * NO TWO ACTIONS SHIP THE SAME DEFAULT CHORD — core OR contributed.
 *
 * `actions.test.ts` already pins the built-in table against itself. That table
 * is only half the map: `allKeybindActions()` folds in every `KEYBINDS_AREA`
 * contribution, plugins register theirs at load, and nothing anywhere compared
 * the two halves. MJXHRM-445's Bot Mode was designed with ⌘⇧B, which the
 * shipped `workspace.newWorktree` has had since MJXHRM-62 — a collision no
 * design and no test caught, because there was no test to catch it.
 *
 * So this loads the REAL bundled plugins through the REAL discovery pass and
 * asserts over the merged list. A future in-tree plugin claiming a taken chord
 * fails here, at the only moment anyone can still choose a different one.
 *
 * `KEYBIND_READONLY` is deliberately NOT compared: `composer.focus` ships `/`
 * and `enter` on purpose, and those are the same keys `composer.slash` and
 * `composer.steer` claim once the composer already HAS focus. Two context-local
 * shortcuts on one key is not a collision — two global defaults on one chord is.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'

import { allKeybindActions, type KeybindContribution, KEYBINDS_AREA } from './actions'

beforeAll(async () => {
  // The bundled plugins register their contributions here — the whole reason
  // this file exists as a separate suite from `actions.test.ts`, which must stay
  // able to run without booting the plugin host.
  const { discoverBundledPlugins } = await import('@/contrib/plugins')

  discoverBundledPlugins()
})

/** A chord is the same chord however its modifiers were typed. */
const canonical = (combo: string): string =>
  combo
    .toLowerCase()
    .split('+')
    .map(part => part.trim())
    .filter(Boolean)
    .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
    .join('+')

describe('default chords are unique across core and contributed actions', () => {
  it('gives no two actions the same default combo', () => {
    const owners = new Map<string, string>()
    const clashes: string[] = []

    for (const action of allKeybindActions()) {
      for (const combo of action.defaults) {
        const key = canonical(combo)
        const owner = owners.get(key)

        if (owner) {
          clashes.push(`${combo}: ${owner} vs ${action.id}`)
        } else {
          owners.set(key, action.id)
        }
      }
    }

    expect(clashes).toEqual([])
  })

  // The reason this file exists at all: prove the scan actually SEES the
  // contributed half. A green run over core-only rows would be a test that
  // cannot fail for the thing it was written for.
  it('detects a clash contributed from a plugin, not just a core one', () => {
    const dispose = registry.register({
      area: KEYBINDS_AREA,
      data: {
        defaults: ['mod+shift+b'],
        id: 'probe:collides',
        label: 'Probe',
        run: () => undefined
      } satisfies KeybindContribution,
      id: 'probe:collides',
      source: 'plugin:probe'
    })

    try {
      const seen = new Set<string>()
      const clashes: string[] = []

      for (const action of allKeybindActions()) {
        for (const combo of action.defaults) {
          const key = canonical(combo)

          if (seen.has(key)) {
            clashes.push(`${combo}: ${action.id}`)
          }

          seen.add(key)
        }
      }

      expect(clashes).toEqual(['mod+shift+b: probe:collides'])
    } finally {
      dispose()
    }
  })
})
