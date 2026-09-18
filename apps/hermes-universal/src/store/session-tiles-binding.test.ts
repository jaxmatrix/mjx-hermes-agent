/**
 * MJXHRM-591 — a tab belongs to a connection, and keeps belonging to it.
 *
 * Invariant 37: a connection or profile switch changes nothing about a tab.
 * Invariant 38: a bound tab's ref is immutable — a backend change makes it
 *               UNAVAILABLE (Close and nothing else), never repointed.
 * Invariant 41: v2 tiles migrate into v3 once, and a v3 read never resurrects
 *               the profile-keyed shape.
 *
 * Invariant 38's first half is enforced by the COMPILER (`SessionTilePatch`
 * omits every ref field), so it is not asserted here — a test that could observe
 * it would be a test that could compile a repoint.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { $layoutTree } from '@/components/pane-shell/tree/store'
import { sessionTilePaneId } from '@/lib/pane-ids'
import { readKey, writeKey } from '@/lib/persist'
import { $activeProfile } from '@/store/profiles'
import { $sessionStates, emptySessionState, publishSessionState, runtimeKeyFor } from '@/store/session-state-types'
import {
  $sessionTiles,
  migrateLegacyTiles,
  saveSessionTiles,
  type SessionTile,
  tileActions,
  tileKeyFor,
  tileRuntimeKey,
  UNAVAILABLE_TILE_ACTIONS
} from '@/store/session-states'

const TILES_V2 = 'hermes.sessionTiles.v2'
const TILES_V3 = 'hermes.sessionTiles.v3'

const tile = (
  connectionId: string,
  profile: string,
  storedSessionId: string,
  rest: Partial<SessionTile> = {}
): SessionTile => ({
  connectionId,
  profile,
  storedSessionId,
  tileKey: tileKeyFor({ connectionId, profile, storedSessionId }),
  ...rest
})

beforeEach(() => {
  writeKey(TILES_V2, null)
  writeKey(TILES_V3, null)
  $sessionTiles.set([])
  $sessionStates.set({})
  $layoutTree.set(null)
  $activeProfile.set('default')
})

describe('invariant 37 — a switch leaves every tab where it is', () => {
  it('keeps both connections’ tabs, and both slices, across a profile switch', () => {
    const a = tile('conn-a', 'default', 'abc12345')
    const b = tile('conn-b', 'work', 'abc12345')

    saveSessionTiles([a, b])

    const keyA = runtimeKeyFor('conn-a', 'run-a')
    const keyB = runtimeKeyFor('conn-b', 'run-b')

    publishSessionState(keyA, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-a',
      profile: 'default',
      runtimeSessionId: 'run-a'
    })
    publishSessionState(keyB, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-b',
      profile: 'work',
      runtimeSessionId: 'run-b'
    })

    $activeProfile.set('other')
    $activeProfile.set('default')

    expect($sessionTiles.get().map(t => t.tileKey)).toEqual([a.tileKey, b.tileKey])
    expect($sessionStates.get()[keyA]?.runtimeSessionId).toBe('run-a')
    expect($sessionStates.get()[keyB]?.runtimeSessionId).toBe('run-b')
  })

  it('resolves each tab to its OWN slice when two backends minted the same id', () => {
    const a = tile('conn-a', 'default', 'abc12345')
    const b = tile('conn-b', 'default', 'abc12345')

    saveSessionTiles([a, b])
    publishSessionState(runtimeKeyFor('conn-a', 'run-a'), {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-a',
      profile: 'default',
      runtimeSessionId: 'run-a'
    })
    publishSessionState(runtimeKeyFor('conn-b', 'run-b'), {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-b',
      profile: 'default',
      runtimeSessionId: 'run-b'
    })

    expect(tileRuntimeKey(a.tileKey)).toBe(runtimeKeyFor('conn-a', 'run-a'))
    expect(tileRuntimeKey(b.tileKey)).toBe(runtimeKeyFor('conn-b', 'run-b'))
  })
})

describe('invariant 38 — a bound tab’s ref is immutable', () => {
  it('refuses a list write that repoints an existing tab', () => {
    const bound = tile('conn-a', 'default', 'abc12345')

    saveSessionTiles([bound])
    // The same KEY, a different backend: the shape a merge or a restored blob
    // can produce, which the patch type alone cannot catch.
    saveSessionTiles([{ ...bound, connectionId: 'conn-b' }])

    expect($sessionTiles.get()[0].connectionId).toBe('conn-a')
    expect(JSON.parse(readKey(TILES_V3) ?? '[]')[0].connectionId).toBe('conn-a')
  })

  it('offers an unavailable tab exactly one verb', () => {
    const changed = tile('conn-a', 'default', 'abc12345', { unavailable: true })

    expect(tileActions(changed)).toEqual(['close'])
    expect(UNAVAILABLE_TILE_ACTIONS).toEqual(['close'])
    expect(tileActions(tile('conn-a', 'default', 'def67890'))).toContain('retry')
  })
})

describe('invariant 41 — the v2 migration runs once', () => {
  it('assigns the registry primary, keeps the profile, and renames the pane', () => {
    writeKey(
      TILES_V2,
      JSON.stringify({
        default: [{ dir: 'right', storedSessionId: 'abc12345' }],
        work: [{ anchor: 'workspace', dir: 'center', storedSessionId: 'def67890' }]
      })
    )
    $layoutTree.set({
      active: sessionTilePaneId('abc12345'),
      id: 'g1',
      panes: ['workspace', sessionTilePaneId('abc12345')],
      type: 'group'
    })

    migrateLegacyTiles('conn-a')

    const stored = JSON.parse(readKey(TILES_V3) ?? '[]') as SessionTile[]

    expect(stored).toEqual([
      {
        anchor: undefined,
        before: undefined,
        connectionId: 'conn-a',
        dir: 'right',
        profile: 'default',
        storedSessionId: 'abc12345'
      },
      {
        anchor: 'workspace',
        before: undefined,
        connectionId: 'conn-a',
        dir: 'center',
        profile: 'work',
        storedSessionId: 'def67890'
      }
    ])
    expect($sessionTiles.get().map(t => t.tileKey)).toEqual([
      tileKeyFor({ connectionId: 'conn-a', profile: 'default', storedSessionId: 'abc12345' }),
      tileKeyFor({ connectionId: 'conn-a', profile: 'work', storedSessionId: 'def67890' })
    ])

    // The tab's pane moved with its key, so a restored layout keeps its slot.
    const tree = $layoutTree.get()

    expect(tree?.type === 'group' && tree.panes).toEqual([
      'workspace',
      sessionTilePaneId(tileKeyFor({ connectionId: 'conn-a', profile: 'default', storedSessionId: 'abc12345' }))
    ])
  })

  it('deletes v2, so a second read resurrects nothing', () => {
    writeKey(TILES_V2, JSON.stringify({ default: [{ storedSessionId: 'abc12345' }] }))

    migrateLegacyTiles('conn-a')
    expect(readKey(TILES_V2)).toBeNull()

    saveSessionTiles([])
    migrateLegacyTiles('conn-a')

    expect($sessionTiles.get()).toEqual([])
    expect(readKey(TILES_V3)).toBeNull()
  })

  it('keeps the local connection’s keys byte-identical to the legacy ones', () => {
    writeKey(TILES_V2, JSON.stringify({ default: [{ storedSessionId: 'abc12345' }] }))

    migrateLegacyTiles('local')

    expect($sessionTiles.get()[0].tileKey).toBe('abc12345')
  })
})
