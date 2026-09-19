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
import { $sessionKeyStates, emptySessionState, publishSessionState, runtimeKeyFor } from '@/store/session-state-types'
import {
  $sessionKeyTabs,
  dropUnheldSessionStates,
  migrateLegacyTiles,
  noteTileBackendIdentity,
  refreshTileTitles,
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
  $sessionKeyTabs.set([])
  $sessionKeyStates.set({})
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

    expect($sessionKeyTabs.get().map(t => t.tileKey)).toEqual([a.tileKey, b.tileKey])
    expect($sessionKeyStates.get()[keyA]?.runtimeSessionId).toBe('run-a')
    expect($sessionKeyStates.get()[keyB]?.runtimeSessionId).toBe('run-b')
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

    expect($sessionKeyTabs.get()[0].connectionId).toBe('conn-a')
    expect(JSON.parse(readKey(TILES_V3) ?? '[]')[0].connectionId).toBe('conn-a')
  })

  it('learns the backend it bound to, once', () => {
    const tab = tile('conn-a', 'default', 'abc12345')

    saveSessionTiles([tab])

    expect(noteTileBackendIdentity(tab.tileKey, 'ssh:deploy@box:22')).toBe(true)
    expect($sessionKeyTabs.get()[0].backendIdentity).toBe('ssh:deploy@box:22')

    // The same machine again is just the same tab.
    expect(noteTileBackendIdentity(tab.tileKey, 'ssh:deploy@box:22')).toBe(true)
    expect($sessionKeyTabs.get()[0].unavailable).toBeUndefined()
  })

  it('goes unavailable when a DIFFERENT backend answers, keeping its ref', () => {
    const tab = tile('conn-a', 'default', 'abc12345')

    saveSessionTiles([tab])
    noteTileBackendIdentity(tab.tileKey, 'ssh:deploy@box:22')

    // The row was re-pointed at another host. A shared stored id across two
    // backends is expected, not meaningful — adopting it would show another
    // machine's chat under this tab's history.
    expect(noteTileBackendIdentity(tab.tileKey, 'ssh:deploy@other:22')).toBe(false)

    const after = $sessionKeyTabs.get()[0]

    expect(after).toMatchObject({ connectionId: 'conn-a', storedSessionId: 'abc12345', unavailable: true })
    expect(after.backendIdentity).toBe('ssh:deploy@box:22')
    expect(tileActions(after)).toEqual(['close'])
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
    expect($sessionKeyTabs.get().map(t => t.tileKey)).toEqual([
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

    expect($sessionKeyTabs.get()).toEqual([])
    expect(readKey(TILES_V3)).toBeNull()
  })

  it('keeps the local connection’s keys byte-identical to the legacy ones', () => {
    writeKey(TILES_V2, JSON.stringify({ default: [{ storedSessionId: 'abc12345' }] }))

    migrateLegacyTiles('local')

    expect($sessionKeyTabs.get()[0].tileKey).toBe('abc12345')
  })
})

describe('invariant 37 — a switch touches only what it leaves', () => {
  const bind = (connectionId: string, runtimeId: string) => {
    const tab = tile(connectionId, 'default', 'abc12345')
    const key = runtimeKeyFor(connectionId, runtimeId)

    publishSessionState(key, {
      ...emptySessionState('abc12345'),
      connectionId,
      messages: [{ id: 'm1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      profile: 'default',
      runtimeSessionId: runtimeId
    })

    return { key, tab }
  }

  it('keeps a bound tab\u2019s slice and runtime binding when its own connection is left', () => {
    const a = bind('conn-a', 'run-a')
    const b = bind('conn-b', 'run-b')

    saveSessionTiles([a.tab, b.tab])

    // Leaving A: its tab is HANDED OVER, not unbound — the slice, the ref and
    // the runtime id all stand, which is what lets it go on streaming on A's
    // own client.
    dropUnheldSessionStates('conn-a')

    expect($sessionKeyStates.get()[a.key]?.runtimeSessionId).toBe('run-a')
    expect($sessionKeyStates.get()[b.key]?.runtimeSessionId).toBe('run-b')
    expect($sessionKeyTabs.get().map(t => t.tileKey)).toEqual([a.tab.tileKey, b.tab.tileKey])
    expect($sessionKeyTabs.get().every(t => t.connectionId !== '')).toBe(true)
  })

  it('drops only the leaving connection\u2019s slices that no tab holds', () => {
    const a = bind('conn-a', 'run-a')
    const held = bind('conn-b', 'run-b')

    saveSessionTiles([held.tab])

    const loose = runtimeKeyFor('conn-a', 'loose')
    const elsewhere = runtimeKeyFor('conn-c', 'stranger')

    publishSessionState(loose, { ...emptySessionState('def67890'), connectionId: 'conn-a', profile: 'default' })
    publishSessionState(elsewhere, { ...emptySessionState('def67890'), connectionId: 'conn-c', profile: 'default' })

    dropUnheldSessionStates('conn-a')

    expect($sessionKeyStates.get()[loose]).toBeUndefined()
    expect($sessionKeyStates.get()[a.key]).toBeUndefined()
    expect($sessionKeyStates.get()[held.key]).toBeDefined()
    // Another connection's loose slice is none of this switch's business.
    expect($sessionKeyStates.get()[elsewhere]).toBeDefined()
  })
})

describe('invariant 37 — the headline: a bound tab keeps streaming across a switch', () => {
  it('lands A\u2019s frames in A\u2019s slice after the app has moved to B', async () => {
    const { $activeConnection } = await import('@/store/active-connection')
    const { routeGatewayEvent } = await import('@/store/event-router')

    const tab = tile('conn-a', 'default', 'abc12345')
    const key = runtimeKeyFor('conn-a', 'run-a')

    saveSessionTiles([tab])
    publishSessionState(key, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-a',
      profile: 'default',
      runtimeSessionId: 'run-a'
    })

    // The app was on A, and moves to B — the switch's own wipe included.
    $activeConnection.set({ connectionId: 'conn-a', profile: 'default', scopeKey: 'conn-a' } as unknown as never)
    dropUnheldSessionStates('conn-a')
    $activeConnection.set({ connectionId: 'conn-b', profile: 'default', scopeKey: 'conn-b' } as unknown as never)

    // A frame delivered on A's OWN client, after the switch.
    routeGatewayEvent({
      connectionId: 'conn-a',
      payload: { text: 'still mine' },
      session_id: 'run-a',
      type: 'status.update'
    } as never)

    const slice = $sessionKeyStates.get()[key]

    expect(slice?.statusLine).toBe('still mine')
    expect(slice?.runtimeSessionId).toBe('run-a')
    expect($sessionKeyTabs.get()[0]).toMatchObject({ connectionId: 'conn-a', storedSessionId: 'abc12345' })

    $activeConnection.set(null)
  })
})

describe('invariant 43 — a tab keeps its name when the rows go', () => {
  it('takes its title from its OWN connection\u2019s row, and persists it', () => {
    const a = tile('conn-a', 'default', 'abc12345')

    saveSessionTiles([a])
    refreshTileTitles([
      { connection_id: 'conn-b', id: 'abc12345', title: 'Another machine' },
      { connection_id: 'conn-a', id: 'abc12345', title: 'Deploy notes' }
    ])

    expect($sessionKeyTabs.get()[0].title).toBe('Deploy notes')
    expect(JSON.parse(readKey(TILES_V3) ?? '[]')[0].title).toBe('Deploy notes')
  })

  it('keeps the last known name when the rows are emptied by a switch', () => {
    const a = tile('conn-a', 'default', 'abc12345')

    saveSessionTiles([a])
    refreshTileTitles([{ connection_id: 'conn-a', id: 'abc12345', title: 'Deploy notes' }])
    refreshTileTitles([])

    expect($sessionKeyTabs.get()[0].title).toBe('Deploy notes')
  })
})

describe('v1.2 \u00a74 addenda \u2014 the artifact registry and the boot marker', () => {
  it('drops only the leaving connection\u2019s artifacts, keeping an open tab\u2019s', async () => {
    const { $artifactRegistry, dropArtifactsForConnection, upsertArtifact } = await import('@/store/artifacts')

    $artifactRegistry.set({})

    const open = tile('conn-a', 'default', 'abc12345')

    saveSessionTiles([open])
    upsertArtifact(open.tileKey, { kind: 'html', language: 'html', title: 'Held' }, '<html>held</html>')
    upsertArtifact('@conn-a|default|loose', { kind: 'html', language: 'html', title: 'Loose' }, '<html>loose</html>')
    upsertArtifact('@conn-b|default|abc12345', { kind: 'html', language: 'html', title: 'Other' }, '<html>other</html>')

    const { heldSessionKeys } = await import('@/store/session-states')

    dropArtifactsForConnection('conn-a', heldSessionKeys())

    const keys = Object.keys($artifactRegistry.get())

    expect(keys).toContain(open.tileKey)
    expect(keys).toContain('@conn-b|default|abc12345')
    expect(keys).not.toContain('@conn-a|default|loose')
  })

  it('remembers the boot chat per connection, and forgets only the one left', async () => {
    const { $activeConnection } = await import('@/store/active-connection')
    const { $activeStoredSessionId, forgetLastSessionMarkers, lastOpenedSessionId } = await import('@/store/session')

    forgetLastSessionMarkers()

    $activeConnection.set({ connectionId: 'conn-a', profile: 'default', scopeKey: 'conn-a' } as unknown as never)
    $activeStoredSessionId.set('a-chat')

    $activeConnection.set({ connectionId: 'conn-b', profile: 'default', scopeKey: 'conn-b' } as unknown as never)
    $activeStoredSessionId.set('b-chat')

    expect(lastOpenedSessionId()).toBe('b-chat')

    // Leaving B forgets B's place and leaves A's, so coming back to A lands
    // where the user was — and B's id can never be opened on A.
    forgetLastSessionMarkers('conn-b')

    expect(lastOpenedSessionId()).toBeNull()

    $activeConnection.set({ connectionId: 'conn-a', profile: 'default', scopeKey: 'conn-a' } as unknown as never)

    expect(lastOpenedSessionId()).toBe('a-chat')

    $activeConnection.set(null)
  })
})
