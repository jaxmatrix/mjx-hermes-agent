/**
 * `pane.reveal` / `layout.apply` — the agent driving the shell (MJXHRM-472).
 *
 * These two frames have NO respond method, so a wrong answer is silent: the
 * tool has already told the agent `{"success": true}` by the time the renderer
 * sees the event. That makes "what happens on a fixture that disagrees" (an
 * unknown pane, a preset id that is not a layout, a window that does not own
 * the layout) the only thing worth asserting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({
  applyLayoutPreset: vi.fn(),
  owns: true,
  revealReview: vi.fn(),
  revealTreePane: vi.fn()
}))

vi.mock('@/components/pane-shell/tree/store', () => ({ revealTreePane: shell.revealTreePane }))
vi.mock('@/store/review', () => ({ revealReview: shell.revealReview }))
vi.mock('@/store/windows', () => ({ ownsPersistedAppState: () => shell.owns }))
// LAYOUTS_AREA is inlined rather than re-exported from the real module: the
// module registers persisted user presets at import time, which would drag
// localStorage into a test about id resolution.
vi.mock('@/components/pane-shell/tree/presets', () => ({
  applyLayoutPreset: shell.applyLayoutPreset,
  LAYOUTS_AREA: 'layouts'
}))

import { registry } from '@/contrib/registry'

import { applyBridgeLayoutPreset, revealBridgePane } from './pane-focus'

const TREE = { active: 'workspace', id: 'grp', panes: ['workspace'], type: 'group' as const }

const disposers: (() => void)[] = []

const contribute = (id: string, data: unknown) => {
  disposers.push(registry.register({ area: 'layouts', data, id, source: 'core', title: id }))
}

beforeEach(() => {
  shell.owns = true
  shell.applyLayoutPreset.mockClear()
  shell.revealReview.mockClear()
  shell.revealTreePane.mockClear()
})

afterEach(() => {
  while (disposers.length) {
    disposers.pop()?.()
  }
})

describe('pane.reveal → revealBridgePane', () => {
  // The tool's enum is `chat, files, terminal, review, sessions`
  // (tools/focus_pane_tool.py). Every one must land somewhere real — a name
  // that silently does nothing is worse than an unknown one, because the tool
  // reports success either way.
  it.each([
    ['chat', 'workspace'],
    ['files', 'files'],
    ['sessions', 'sessions'],
    ['terminal', 'terminal']
  ])('reveals the tree pane for %s', (pane, paneId) => {
    expect(revealBridgePane(pane)).toBe(true)
    expect(shell.revealTreePane).toHaveBeenCalledWith(paneId)
  })

  // Not `revealTreePane('review')`: the diff has to be LOADED, and on a narrow
  // viewport the pane is an overlay rather than a tree pane.
  it('routes review through revealReview, which also loads the diff', () => {
    expect(revealBridgePane('review')).toBe(true)
    expect(shell.revealReview).toHaveBeenCalledTimes(1)
    expect(shell.revealTreePane).not.toHaveBeenCalled()
  })

  it('rejects a pane name the shell does not have, without touching the tree', () => {
    expect(revealBridgePane('browser')).toBe(false)
    expect(revealBridgePane('')).toBe(false)
    expect(shell.revealTreePane).not.toHaveBeenCalled()
    expect(shell.revealReview).not.toHaveBeenCalled()
  })

  // A detached tile, the HUD, or an Android activity screen shares this
  // origin's storage but not the app's layout. Revealing from one writes over
  // the real window's tree.
  it('refuses in a window that does not own the app state', () => {
    shell.owns = false

    expect(revealBridgePane('terminal')).toBe(false)
    expect(shell.revealTreePane).not.toHaveBeenCalled()
  })
})

describe('layout.apply → applyBridgeLayoutPreset', () => {
  it('applies a preset registered in the layouts area', () => {
    contribute('bridge-test-preset', TREE)

    expect(applyBridgeLayoutPreset('bridge-test-preset')).toBe(true)
    expect(shell.applyLayoutPreset).toHaveBeenCalledWith('bridge-test-preset', TREE)
  })

  it('rejects an unknown preset id rather than applying a fallback layout', () => {
    expect(applyBridgeLayoutPreset('no-such-preset')).toBe(false)
    expect(shell.applyLayoutPreset).not.toHaveBeenCalled()
  })

  // Preset ids are free-form (plugins and users mint their own), and the
  // layouts area is a plain contribution area — so a contribution can exist
  // under the right id carrying something that is NOT a tree.
  it('rejects a contribution whose data is not a layout node', () => {
    contribute('bridge-test-junk', { looks: 'nothing like a tree' })

    expect(applyBridgeLayoutPreset('bridge-test-junk')).toBe(false)
    expect(shell.applyLayoutPreset).not.toHaveBeenCalled()
  })

  it('rejects an empty preset id', () => {
    expect(applyBridgeLayoutPreset('')).toBe(false)
    expect(shell.applyLayoutPreset).not.toHaveBeenCalled()
  })

  it('refuses in a window that does not own the app state', () => {
    contribute('bridge-test-secondary', TREE)
    shell.owns = false

    expect(applyBridgeLayoutPreset('bridge-test-secondary')).toBe(false)
    expect(shell.applyLayoutPreset).not.toHaveBeenCalled()
  })
})
