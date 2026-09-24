/**
 * Layout keys stay under `hermes.desktop.*` (matching desktop and
 * `LAYOUT_KEYS` in `lib/layout-persistence.ts`). An earlier draft renamed
 * them to `hermes.layout.*`; that migration never shipped — asserting it
 * would green over silent no-ops.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LAYOUT_KEYS } from '@/lib/layout-persistence'

const importStore = async () => {
  vi.resetModules()

  return import('./store')
}

beforeEach(() => {
  localStorage.clear()
})

describe('layout persistence keys', () => {
  it('keeps the desktop-shaped tree and preset keys', async () => {
    localStorage.setItem(LAYOUT_KEYS.preset, 'quad')
    const tree = JSON.stringify({ type: 'group', id: 'z', panes: ['workspace'], active: 'workspace' })
    localStorage.setItem(LAYOUT_KEYS.tree, tree)

    await importStore()

    expect(localStorage.getItem(LAYOUT_KEYS.preset)).toBe('quad')
    expect(localStorage.getItem(LAYOUT_KEYS.tree)).toBe(tree)
    expect(localStorage.getItem('hermes.layout.preset.active')).toBeNull()
    expect(localStorage.getItem('hermes.layout.tree.v2')).toBeNull()
  })

  it('does not invent hermes.layout.* keys on a fresh install', async () => {
    await importStore()

    expect(Object.keys(localStorage).filter(k => k.startsWith('hermes.layout.'))).toEqual([])
  })
})
