/**
 * MJXHRM-452 — the `session.archive` hotkey.
 *
 * It archives the FOCUSED session, not the selected one: on a multi-tile shell
 * the chat you are looking at can be a tile, and archiving the workspace's
 * session out from under a focused tile is the opposite of what the key
 * promises. The action ships UNBOUND — an irreversible-feeling, mouse-only verb
 * should not silently claim a chord for every user.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as SessionStore from '@/store/session'

const archiveSessionLocal = vi.fn(async (_id: string) => {})

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: vi.fn()
  }
})

vi.mock('@/store/session', async importOriginal => ({
  ...(await importOriginal<typeof SessionStore>()),
  archiveSessionLocal: (id: string) => archiveSessionLocal(id)
}))

import { group, split } from '@/components/pane-shell/tree/model'
import { declareDefaultTree, noteActiveTreeGroup } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'
import { KEYBIND_ACTIONS } from '@/lib/keybinds/actions'

import { $activeStoredSessionId } from './session'
import { archiveActiveSession } from './session-lookup'
import { $sessionTiles, type SessionTile } from './session-states'

const tile = (storedSessionId: string): SessionTile => ({ storedSessionId }) as SessionTile

beforeEach(() => {
  archiveSessionLocal.mockClear()
  $sessionTiles.set([])
  $activeStoredSessionId.set(null)

  for (const id of ['workspace', 'session-tile:tiled']) {
    registry.register({
      area: 'panes',
      data: id === 'workspace' ? { placement: 'main', uncloseable: true } : { placement: 'main' },
      id,
      render: () => null,
      title: id
    })
  }

  declareDefaultTree(
    split('row', [
      group(['workspace'], { active: 'workspace', id: 'grp-main' }),
      group(['session-tile:tiled'], { active: 'session-tile:tiled', id: 'grp-tile' })
    ])
  )
  noteActiveTreeGroup('grp-main')
})

describe('session.archive', () => {
  it('is registered as a rebindable action with no default chord', () => {
    const action = KEYBIND_ACTIONS.find(a => a.id === 'session.archive')

    expect(action).toBeDefined()
    expect(action?.category).toBe('session')
    expect(action?.defaults).toEqual([])
  })

  it('archives the selected session when nothing else has focus', async () => {
    $activeStoredSessionId.set('selected')

    await archiveActiveSession()

    expect(archiveSessionLocal).toHaveBeenCalledWith('selected')
  })

  it('archives the FOCUSED tile, not the session the workspace holds', async () => {
    // The two disagree on purpose: the workspace is on `selected` while the
    // user's focus is in the tile showing `tiled`. Reading the selection here
    // archives a conversation the user is not even looking at.
    $activeStoredSessionId.set('selected')
    $sessionTiles.set([tile('tiled')])
    noteActiveTreeGroup('grp-tile')

    await archiveActiveSession()

    expect(archiveSessionLocal).toHaveBeenCalledWith('tiled')
  })

  it('does nothing on a fresh draft, which has no stored row', async () => {
    // Seeded to disagree with "just call it": a tile exists, so a handler that
    // reached for any session at all would still fire.
    $sessionTiles.set([tile('some-tile')])

    await archiveActiveSession()

    expect(archiveSessionLocal).not.toHaveBeenCalled()
  })
})
