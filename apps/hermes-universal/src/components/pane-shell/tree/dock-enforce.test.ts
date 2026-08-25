/**
 * `TileDockHint.enforce` — the standing owner invariant (MJXHRM-445 §4.2).
 *
 * Driven through the REAL `enforceDockedPanes` off `watchContributedPanes`,
 * not through the predicate in isolation: the whole behaviour is about what a
 * PERSISTED tree does at the next boot, and only the store persists.
 *
 * A "boot" here is `vi.resetModules()` + a fresh import, which re-reads the
 * persisted tree from localStorage and starts with an empty per-boot ledger —
 * exactly what a relaunch does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('enforced docks', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
  })

  /** One boot: fresh modules, the default tree declared, the tiles registered. */
  async function boot(options: { enforce?: boolean } = {}) {
    vi.resetModules()

    const tree = await import('@/components/pane-shell/tree/store')
    const model = await import('@/components/pane-shell/tree/model')
    const { registerTiles } = await import('@/components/pane-shell/tile/registry')

    registerTiles([
      { id: 'workspace', kind: 'chat', placement: 'main', render: () => null, title: 'chat' },
      { id: 'sessions', kind: 'sessions', placement: 'left', render: () => null, title: 'Sessions' },
      {
        chrome: { dock: { enforce: options.enforce ?? true, pane: 'sessions', pos: 'center' } },
        id: 'bots',
        kind: 'bots',
        placement: 'left',
        render: () => null,
        title: 'Bots'
      }
    ])

    tree.declareDefaultTree(
      model.split('row', [model.group(['sessions'], { id: 'grp-rail' }), model.group(['workspace'], { id: 'grp-main' })])
    )

    tree.watchContributedPanes()

    return { model, tree }
  }

  type Booted = Awaited<ReturnType<typeof boot>>

  const groupOf = ({ model, tree }: Booted, paneId: string) => model.findGroupOfPane(tree.$layoutTree.get()!, paneId)

  it('stacks the enforced tile into its anchor group without stealing the active tab', async () => {
    const { model, tree } = await boot()

    const rail = groupOf({ model, tree }, 'bots')

    expect(rail?.panes).toEqual(['sessions', 'bots'])
    // Silent adoption: the strip opens on SESSIONS, not on the newcomer.
    expect(rail?.active).toBe('sessions')
  })

  it('re-homes a tile the USER dragged out — the invariant beats the drag record', async () => {
    const first = await boot()

    // The user drags BOTS into the main zone. `moveTreePane` is what a real
    // drag commits, and it stamps the pane user-placed.
    first.tree.moveTreePane('bots', { groupId: 'grp-main', pos: 'center' })
    expect(groupOf(first, 'bots')?.id).toBe('grp-main')
    expect(first.tree.$userPlacedPanes.get().has('bots')).toBe(true)

    // Still out for the rest of THIS session — the pass already spent its turn.
    first.tree.watchContributedPanes()
    expect(groupOf(first, 'bots')?.id).toBe('grp-main')

    // Next launch: back in the strip.
    const next = await boot()

    expect(groupOf(next, 'bots')?.panes).toContain('sessions')
  })

  it('leaves a NON-enforced dock alone once the user has moved it', async () => {
    const first = await boot({ enforce: false })

    expect(groupOf(first, 'bots')?.panes).toEqual(['sessions', 'bots'])

    first.tree.moveTreePane('bots', { groupId: 'grp-main', pos: 'center' })

    const next = await boot({ enforce: false })

    // A plain `dock` is a one-shot: the pane is already in the tree, so nothing
    // re-homes it and the user's placement survives the relaunch.
    expect(groupOf(next, 'bots')?.id).toBe('grp-main')
  })

  it('forces the strip header shown when the enforced tab is co-located but hidden', async () => {
    const first = await boot()

    const railId = groupOf(first, 'bots')!.id

    first.tree.setTreeGroupHeaderHidden(railId, true)
    expect(groupOf(first, 'bots')?.headerHidden).toBe(true)

    // Hiding it again inside the session sticks — the pass is spent.
    first.tree.watchContributedPanes()
    expect(groupOf(first, 'bots')?.headerHidden).toBe(true)

    // But a relaunch into that layout must not strand the user on a tab strip
    // with no strip: co-located is not the same as reachable.
    const next = await boot()

    expect(groupOf(next, 'bots')?.headerHidden).not.toBe(true)
  })

  it('leaves a correctly placed enforced tile untouched', async () => {
    const { model, tree } = await boot()

    const before = tree.$layoutTree.get()

    tree.watchContributedPanes()

    expect(tree.$layoutTree.get()).toBe(before)
    expect(groupOf({ model, tree }, 'bots')?.panes).toEqual(['sessions', 'bots'])
  })
})
