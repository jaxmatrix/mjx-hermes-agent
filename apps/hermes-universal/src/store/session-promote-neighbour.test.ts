/**
 * MJXHRM-452 — closing MAIN promotes the neighbouring session, not a fresh draft.
 *
 * The workspace pane cannot leave the tree, so "closing" it means EMPTYING it,
 * and `nextSessionTileForWorkspace` picks what fills the hole: the nearest chat
 * tab in main's OWN group, scanning right first and then left.
 *
 * Two placement rules ride on that scoping:
 *
 *  - FLOATING panes are rendered outside the tree's tab strips and are never in
 *    main's group, so the group scoping already excludes them.
 *  - DETACHED tiles are NOT excluded by scoping: detach deliberately keeps the
 *    tile's slot in the tree (that is what makes reattach well-defined), so a
 *    chat being shown by another native window is still a tab here. Promoting
 *    one would close it out from under that window.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: vi.fn()
  }
})

import { $detachedTiles } from '@/components/pane-shell/tile/detach'
import { group, split } from '@/components/pane-shell/tree/model'
import { declareDefaultTree } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'

import { $sessionTiles, nextSessionTileForWorkspace, type SessionTile } from './session-states'

const tile = (storedSessionId: string): SessionTile => ({ storedSessionId }) as SessionTile

beforeEach(() => {
  $detachedTiles.set(new Map())

  for (const id of ['workspace', 'session-tile:left', 'session-tile:right', 'session-tile:far']) {
    registry.register({
      area: 'panes',
      data: id === 'workspace' ? { placement: 'main', uncloseable: true } : { placement: 'main' },
      id,
      render: () => null,
      title: id
    })
  }
})

const mainStrip = (panes: string[]) =>
  declareDefaultTree(split('row', [group(panes, { active: 'workspace', id: 'grp-main' })]))

describe('nextSessionTileForWorkspace', () => {
  it('prefers the tab to the RIGHT of main, then falls back to the left', () => {
    // Seeded to disagree with a naive "first tile in the group": `left` comes
    // first in the strip, but the tab that fills main's slot is the one after it.
    mainStrip(['session-tile:left', 'workspace', 'session-tile:right'])
    $sessionTiles.set([tile('left'), tile('right')])

    expect(nextSessionTileForWorkspace()).toBe('right')
  })

  it('falls back to the left neighbour when nothing sits to the right', () => {
    mainStrip(['session-tile:left', 'workspace'])
    $sessionTiles.set([tile('left')])

    expect(nextSessionTileForWorkspace()).toBe('left')
  })

  it('skips a DETACHED tile and promotes the next real one instead', () => {
    // `right` is the natural pick — and it is being shown by another window.
    mainStrip(['session-tile:left', 'workspace', 'session-tile:right', 'session-tile:far'])
    $sessionTiles.set([tile('left'), tile('right'), tile('far')])
    $detachedTiles.set(new Map([['session-tile:right', 'tile-session-tile-right']]))

    expect(nextSessionTileForWorkspace()).toBe('far')
  })

  it('drops to a fresh draft when every neighbour is detached', () => {
    mainStrip(['workspace', 'session-tile:right'])
    $sessionTiles.set([tile('right')])
    $detachedTiles.set(new Map([['session-tile:right', 'tile-session-tile-right']]))

    expect(nextSessionTileForWorkspace()).toBeNull()
  })

  it('is null when main is the only chat in its zone', () => {
    mainStrip(['workspace'])
    $sessionTiles.set([])

    expect(nextSessionTileForWorkspace()).toBeNull()
  })
})
