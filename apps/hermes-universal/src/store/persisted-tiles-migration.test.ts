import { afterEach, describe, expect, it, vi } from 'vitest'

import { LOCAL_CONNECTION_ID } from '@/lib/backend-scope'
import { DRAFT_TILE_PANE_ID, sessionTilePaneId } from '@/lib/pane-ids'
import { normalizeProfileKey } from '@/store/profile'
import { DEFAULT_SESSION_PROFILE, LOCAL_SESSION_SCOPE, storedKeyFor } from '@/store/session-state-types'

import {
  DESKTOP_TILES_KEY,
  migratedProfileKey,
  migratePersistedTiles,
  migrateTilePaneId,
  runPersistedTilesMigration,
  UNIVERSAL_LEGACY_TILES_KEY,
  UNIVERSAL_TILES_KEY
} from './persisted-tiles-migration'

type Buckets = Record<string, Record<string, unknown>[]>

const bucketsOf = (desktop: null | string): Buckets => JSON.parse(desktop ?? '{}') as Buckets

const pane = (connectionId: string, profile: string, id: string) =>
  sessionTilePaneId(storedKeyFor(connectionId, profile, id))

const v3Tile = (storedSessionId: string, rest: Record<string, unknown> = {}) => ({
  connectionId: 'local',
  profile: 'default',
  storedSessionId,
  title: 'a title',
  ...rest
})

describe('migratePersistedTiles', () => {
  it('buckets a flat v3 list by profile and drops the title', () => {
    const result = migratePersistedTiles({
      v3: JSON.stringify([
        v3Tile('a', { dir: 'right' }),
        v3Tile('b', { connectionId: 'homelab', profile: ' work ' }),
        v3Tile('c', { profile: '' })
      ])
    })

    expect(result).toMatchObject({ changed: true, droppedDuplicates: 0, migrated: 3 })
    expect(bucketsOf(result.desktop)).toEqual({
      default: [
        { dir: 'right', storedSessionId: 'a', workspaceMode: 'sessions' },
        { storedSessionId: 'c', workspaceMode: 'sessions' }
      ],
      work: [
        {
          ownerRoute: { connectionId: 'homelab', profile: 'work' },
          storedSessionId: 'b',
          workspaceMode: 'sessions'
        }
      ]
    })
  })

  it('routes a tab by a real connection id, never by the `local` fallback', () => {
    const result = migratePersistedTiles({
      v3: JSON.stringify([
        v3Tile('a'),
        v3Tile('b', { profile: 'work' }),
        v3Tile('c', { connectionId: undefined }),
        v3Tile('d', { connectionId: 'vps' })
      ])
    })

    const tiles = Object.values(bucketsOf(result.desktop)).flat()

    expect(tiles.map(tile => [tile.storedSessionId, tile.ownerRoute])).toEqual([
      ['a', undefined],
      ['c', undefined],
      ['d', { connectionId: 'vps', profile: 'default' }],
      ['b', undefined]
    ])
    expect(result.desktop).not.toContain('"mode"')
    expect(LOCAL_CONNECTION_ID).toBe('local')
    expect(LOCAL_SESSION_SCOPE).toBe('local')
  })

  it('carries a profile-keyed v2 blob over without a route', () => {
    const result = migratePersistedTiles({
      v2: JSON.stringify({
        '': [{ storedSessionId: 'a', connectionId: 'ignored' }],
        work: [{ anchor: sessionTilePaneId('a'), dir: 'center', storedSessionId: 'b', before: null }, 'junk'],
        broken: 'not a list'
      })
    })

    expect(bucketsOf(result.desktop)).toEqual({
      default: [{ storedSessionId: 'a', workspaceMode: 'sessions' }],
      work: [
        { anchor: sessionTilePaneId('a'), before: null, dir: 'center', storedSessionId: 'b', workspaceMode: 'sessions' }
      ]
    })
  })

  it('takes v3 before v2 when both are present', () => {
    const result = migratePersistedTiles({
      v2: JSON.stringify({ work: [{ storedSessionId: 'a' }, { storedSessionId: 'z' }] }),
      v3: JSON.stringify([v3Tile('a', { connectionId: 'vps' })])
    })

    expect(result).toMatchObject({ droppedDuplicates: 1, migrated: 2 })
    expect(bucketsOf(result.desktop)).toEqual({
      default: [
        { ownerRoute: { connectionId: 'vps', profile: 'default' }, storedSessionId: 'a', workspaceMode: 'sessions' }
      ],
      work: [{ storedSessionId: 'z', workspaceMode: 'sessions' }]
    })
  })

  it("never clobbers desktop's own state, and a tab it already holds wins", () => {
    const desktop = {
      __bots_workspace__: [{ storedSessionId: 'bot', workspaceMode: 'bots', workspaceOwnerKey: 'researcher' }],
      work: [{ storedSessionId: 'a', dir: 'left', futureField: 1 }]
    }

    const result = migratePersistedTiles({
      desktop: JSON.stringify(desktop),
      v3: JSON.stringify([v3Tile('a'), v3Tile('bot', { profile: 'work' }), v3Tile('n', { profile: 'work' })])
    })

    expect(result).toMatchObject({ changed: true, droppedDuplicates: 2, migrated: 1 })
    expect(bucketsOf(result.desktop)).toEqual({
      ...desktop,
      work: [...desktop.work, { storedSessionId: 'n', workspaceMode: 'sessions' }]
    })
  })

  it('deduplicates by stored id across every bucket — first wins, order kept', () => {
    const result = migratePersistedTiles({
      v3: JSON.stringify([
        v3Tile('a', { connectionId: 'one' }),
        v3Tile('b'),
        v3Tile('a', { connectionId: 'two', profile: 'work' }),
        v3Tile('a'),
        v3Tile('c')
      ])
    })

    const buckets = bucketsOf(result.desktop)

    expect(result).toMatchObject({ droppedDuplicates: 2, migrated: 3 })
    expect(Object.keys(buckets)).toEqual(['default'])
    expect(buckets.default.map(tile => tile.storedSessionId)).toEqual(['a', 'b', 'c'])
    expect(buckets.default[0].ownerRoute).toEqual({ connectionId: 'one', profile: 'default' })
  })

  it("rewrites tile pane ids to desktop's spelling and drops draft and dangling ones", () => {
    const result = migratePersistedTiles({
      v3: JSON.stringify([
        v3Tile('a', { connectionId: 'vps', profile: 'work' }),
        v3Tile('b', { anchor: pane('vps', 'work', 'a'), before: pane('local', 'default', 'c') }),
        v3Tile('c', { anchor: DRAFT_TILE_PANE_ID, before: pane('gone', 'work', 'x') }),
        // Loses the dedup to the first `a`, so nothing may point at it.
        v3Tile('a', { connectionId: 'other' }),
        v3Tile('d', { anchor: pane('other', 'default', 'a'), before: null }),
        v3Tile('e', { anchor: 'workspace', before: 'preview:1' })
      ])
    })

    const byId = Object.fromEntries(
      Object.values(bucketsOf(result.desktop))
        .flat()
        .map(tile => [tile.storedSessionId, tile])
    )

    expect(byId.b).toMatchObject({ anchor: sessionTilePaneId('a'), before: sessionTilePaneId('c') })
    expect(byId.c).toEqual({ storedSessionId: 'c', workspaceMode: 'sessions' })
    expect(byId.d).toEqual({ before: null, storedSessionId: 'd', workspaceMode: 'sessions' })
    expect(byId.e).toMatchObject({ anchor: 'workspace', before: 'preview:1' })
  })

  it('drops drafts and placeholders', () => {
    const result = migratePersistedTiles({
      v2: JSON.stringify({ default: [{ storedSessionId: 'hydrating:abc' }] }),
      v3: JSON.stringify([v3Tile('draft'), v3Tile('draft:1'), v3Tile('hydrating:abc'), v3Tile(''), { title: 'no id' }])
    })

    expect(result).toEqual({ changed: false, desktop: null, droppedDuplicates: 0, migrated: 0 })
  })

  it.each([
    ['not json', '{nope'],
    ['a string', '"tiles"'],
    ['a number', '7'],
    ['null', 'null'],
    ['an object where v3 wants a list', '{"a":1}'],
    ['a list of junk', '[null,1,"x",[],{"storedSessionId":5}]']
  ])('skips malformed input: %s', (_label, raw) => {
    const desktop = JSON.stringify({ default: [{ storedSessionId: 'kept' }] })

    expect(migratePersistedTiles({ desktop, v2: raw, v3: raw })).toEqual({
      changed: false,
      desktop,
      droppedDuplicates: 0,
      migrated: 0
    })
    expect(
      bucketsOf(migratePersistedTiles({ desktop: raw, v3: JSON.stringify([v3Tile('a')]) }).desktop).default
    ).toEqual([{ storedSessionId: 'a', workspaceMode: 'sessions' }])
  })

  it('survives a hostile profile name', () => {
    const result = migratePersistedTiles({ v3: JSON.stringify([v3Tile('a', { profile: '__proto__' })]) })

    expect(Object.keys(bucketsOf(result.desktop))).toEqual(['__proto__'])
  })

  it('is idempotent', () => {
    const v3 = JSON.stringify([v3Tile('a'), v3Tile('b', { connectionId: 'vps', profile: 'work' })])
    const first = migratePersistedTiles({ v3 })
    const second = migratePersistedTiles({ desktop: first.desktop, v3 })

    expect(second).toEqual({ changed: false, desktop: first.desktop, droppedDuplicates: 2, migrated: 0 })
    expect(migratePersistedTiles({ desktop: first.desktop })).toMatchObject({ changed: false, desktop: first.desktop })
    expect(migratePersistedTiles({})).toEqual({ changed: false, desktop: null, droppedDuplicates: 0, migrated: 0 })
  })
})

describe('migrateTilePaneId', () => {
  it("decodes every spelling universal's tab keys took", () => {
    expect(migrateTilePaneId(pane(LOCAL_SESSION_SCOPE, DEFAULT_SESSION_PROFILE, 'abc'))).toBe(sessionTilePaneId('abc'))
    expect(migrateTilePaneId(pane('https://h.example:9/x|y', 'wo@rk', 'abc'))).toBe(sessionTilePaneId('abc'))
    expect(migrateTilePaneId(pane('vps', 'work', 'abc'), () => false)).toBeNull()
    expect(migrateTilePaneId(DRAFT_TILE_PANE_ID)).toBeNull()
    expect(migrateTilePaneId('session-tile:@conn|runtime-only')).toBeNull()
    expect(migrateTilePaneId('session-tile:@a|b|%E0%A4%A')).toBeNull()
    expect(migrateTilePaneId('session-tile:')).toBeNull()
    expect(migrateTilePaneId('workspace')).toBe('workspace')
  })
})

describe('migratedProfileKey', () => {
  it.each([['default'], ['work'], ['  work  '], [''], ['   '], [null], [undefined], ['Default']])(
    "matches desktop's normalizeProfileKey for %j",
    input => {
      expect(migratedProfileKey(input)).toBe(normalizeProfileKey(input))
    }
  )

  it('treats a non-string as absent', () => {
    expect(migratedProfileKey(7)).toBe('default')
  })
})

describe('runPersistedTilesMigration', () => {
  afterEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it("writes desktop's key and retires universal's two", () => {
    window.localStorage.setItem(UNIVERSAL_TILES_KEY, JSON.stringify([v3Tile('a')]))
    window.localStorage.setItem(UNIVERSAL_LEGACY_TILES_KEY, '{nope')

    runPersistedTilesMigration(window.localStorage)

    expect(bucketsOf(window.localStorage.getItem(DESKTOP_TILES_KEY)).default).toHaveLength(1)
    expect(window.localStorage.getItem(UNIVERSAL_TILES_KEY)).toBeNull()
    expect(window.localStorage.getItem(UNIVERSAL_LEGACY_TILES_KEY)).toBeNull()
  })

  it("leaves desktop's key alone when universal has nothing", () => {
    window.localStorage.setItem(DESKTOP_TILES_KEY, 'untouched')

    runPersistedTilesMigration(window.localStorage)

    expect(window.localStorage.getItem(DESKTOP_TILES_KEY)).toBe('untouched')
  })

  it("keeps universal's keys when the write fails", () => {
    const stored = JSON.stringify([v3Tile('a')])
    const removeItem = vi.fn()

    runPersistedTilesMigration({
      getItem: key => (key === UNIVERSAL_TILES_KEY ? stored : null),
      removeItem,
      setItem: () => {
        throw new Error('quota')
      }
    })

    expect(removeItem).not.toHaveBeenCalled()
  })

  // The round trip: what the migration writes is what desktop's REAL loader
  // (module-private, run at evaluation) hydrates `$sessionTiles` from.
  it("round-trips through desktop's loader", async () => {
    window.localStorage.setItem(
      UNIVERSAL_TILES_KEY,
      JSON.stringify([
        v3Tile('a', { dir: 'right' }),
        v3Tile('b', { anchor: pane('vps', 'work', 'c'), connectionId: 'vps', dir: 'center', profile: 'work' }),
        v3Tile('c', { connectionId: 'vps', profile: 'work' })
      ])
    )
    runPersistedTilesMigration(window.localStorage)
    vi.resetModules()

    const { $sessionTiles } = await import('@/store/session-states')
    const { $activeGatewayProfile } = await import('@/store/profile')

    $activeGatewayProfile.set('default')
    expect($sessionTiles.get()).toMatchObject([{ dir: 'right', storedSessionId: 'a', workspaceMode: 'sessions' }])
    expect($sessionTiles.get()[0].ownerRoute).toBeUndefined()

    $activeGatewayProfile.set('work')
    expect($sessionTiles.get()).toMatchObject([
      {
        anchor: sessionTilePaneId('c'),
        dir: 'center',
        ownerRoute: { connectionId: 'vps', profile: 'work' },
        storedSessionId: 'b'
      },
      { ownerRoute: { connectionId: 'vps', profile: 'work' }, storedSessionId: 'c' }
    ])
  })
})
