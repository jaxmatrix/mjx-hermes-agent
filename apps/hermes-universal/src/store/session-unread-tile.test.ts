/**
 * MJXHRM-452 — the "finished while you were away" marker on a multi-tile shell.
 *
 * Universal renders many chats at once, so "the session the user is looking at"
 * is `$focusedStoredSessionId` (the interacted chat zone's tile, else the
 * selected session), NOT `$activeStoredSessionId` — a tile is never the latter.
 * Keying either half of the marker on the selection meant:
 *
 *   - a tile the user was watching went green the moment its turn finished, and
 *   - nothing on the tile-fronting path could clear it again.
 *
 * The truth is PER SESSION (one marker for one conversation), with the tiles as
 * an overlay deciding which of them is on screen — so two tiles bound to the
 * same conversation can never disagree, including across a compaction rekey,
 * where one surface holds the lineage root and the other the live tip.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: vi.fn()
  }
})

import type { SessionInfo } from '@/types/hermes'

import { $activeStoredSessionId, $sessions, $unreadFinishedSessionIds } from './session'

const row = (id: string, lineageRoot?: string): SessionInfo =>
  ({ id, ...(lineageRoot ? { _lineage_root_id: lineageRoot } : {}) }) as SessionInfo

async function setup() {
  const tree = await import('@/components/pane-shell/tree/store')
  const model = await import('@/components/pane-shell/tree/model')
  const { registry } = await import('@/contrib/registry')
  const { emptySessionState } = await import('@/store/session-state-types')
  const states = await import('./session-states')

  for (const id of ['workspace', 'session-tile:tiled', 'session-tile:tiled-alias']) {
    registry.register({
      area: 'panes',
      data: id === 'workspace' ? { placement: 'main', uncloseable: true } : { placement: 'main' },
      id,
      render: () => null,
      title: id
    })
  }

  // Workspace holds the primary chat; two further zones hold tiles.
  tree.declareDefaultTree(
    model.split('row', [
      model.group(['workspace'], { active: 'workspace', id: 'grp-main' }),
      model.group(['session-tile:tiled'], { active: 'session-tile:tiled', id: 'grp-tile' }),
      model.group(['session-tile:tiled-alias'], { active: 'session-tile:tiled-alias', id: 'grp-alias' })
    ])
  )

  $unreadFinishedSessionIds.set([])
  $activeStoredSessionId.set('primary')

  const finishTurn = (storedSessionId: string) => {
    const working = { ...emptySessionState(storedSessionId), busy: true, storedSessionId }
    states.publishSessionState(`rt-${storedSessionId}`, working)
    states.publishSessionState(`rt-${storedSessionId}`, { ...working, busy: false })
  }

  return { finishTurn, tree }
}

describe('the unread marker follows the focused session, not the selected one', () => {
  it('clears the marker when an already-open tile is fronted', async () => {
    const { finishTurn, tree } = await setup()

    tree.noteActiveTreeGroup('grp-main')
    finishTurn('tiled')
    expect($unreadFinishedSessionIds.get()).toEqual(['tiled'])

    // Fronting the tile is what a tab click does. Nothing on this path used to
    // clear the marker, so the dot stayed green with no way to dismiss it.
    tree.noteActiveTreeGroup('grp-tile')
    expect($unreadFinishedSessionIds.get()).toEqual([])
  })

  it('never marks a tile that finishes while it is the focused one', async () => {
    const { finishTurn, tree } = await setup()

    tree.noteActiveTreeGroup('grp-tile')
    finishTurn('tiled')

    expect($unreadFinishedSessionIds.get()).toEqual([])
  })

  it('marks the primary session when a tile has focus', async () => {
    const { finishTurn, tree } = await setup()

    tree.noteActiveTreeGroup('grp-tile')
    finishTurn('primary')

    expect($unreadFinishedSessionIds.get()).toEqual(['primary'])
  })

  it('agrees across two tiles bound to one conversation after a rekey', async () => {
    const { finishTurn, tree } = await setup()

    // The compaction case: `tiled-alias` is the pane opened BEFORE the rotation
    // (it holds the lineage root); `tiled` is the live tip. One conversation.
    $sessions.set([row('tiled', 'tiled-alias')])

    tree.noteActiveTreeGroup('grp-main')
    finishTurn('tiled')
    expect($unreadFinishedSessionIds.get()).toEqual(['tiled'])

    // Fronting the OTHER tile — the one holding the root id — has to clear the
    // marker written under the tip. Identity comparison left it unclearable.
    tree.noteActiveTreeGroup('grp-alias')
    expect($unreadFinishedSessionIds.get()).toEqual([])

    // And the reverse: focused on the root, a turn finishing under the tip is
    // not "away" — the two tiles must not disagree about one session.
    finishTurn('tiled')
    expect($unreadFinishedSessionIds.get()).toEqual([])
  })
})
