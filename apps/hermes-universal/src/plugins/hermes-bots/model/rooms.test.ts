import { describe, expect, it } from 'vitest'

import { MAX_SECONDARIES } from '@/store/gateway-secondaries'

import { derivedRoomId } from '../ids'

import type { BotMeta, RoomMembership } from './meta'
import {
  bumpRoom,
  disbandTombstone,
  GROUP_CHAT_MAX_MEMBERS,
  liveRooms,
  MAX_REMOTE_MEMBERS,
  membershipFor,
  mergeRoomRecords,
  migrateV0Memberships,
  newerMembership,
  pruneTombstones,
  type Room,
  roomsFromRoster,
  roomSizeRefusal,
  withRoom
} from './rooms'

const member = (profile: string, connectionId?: string) => ({
  ...(connectionId ? { connectionId } : {}),
  handle: profile,
  profile
})

const membership = (over: Partial<RoomMembership> = {}): RoomMembership => ({
  at: 1_000,
  id: 'r_aaa',
  members: [member('radar'), member('scout')],
  name: 'Ops',
  rev: 1,
  ...over
})

const source = (profile: string, meta: BotMeta, connectionId?: string) => ({
  ...(connectionId ? { connectionId } : {}),
  meta,
  profile
})

const asRoom = (m: RoomMembership, sessions: Record<string, null | string> = {}): Room => ({ ...m, sessions })

describe('room record merge', () => {
  it('lets the higher rev win, and breaks a rev tie on the newer write', () => {
    const older = membership({ name: 'Ops', rev: 2, at: 10 })
    const newer = membership({ name: 'Renamed', rev: 3, at: 5 })

    expect(newerMembership(older, newer).name).toBe('Renamed')

    const tieA = membership({ at: 10, name: 'A', rev: 4 })
    const tieB = membership({ at: 11, name: 'B', rev: 4 })

    expect(newerMembership(tieA, tieB).name).toBe('B')
    expect(newerMembership(tieB, tieA).name).toBe('B')
  })

  it('rebuilds every room from profiles.list alone, unioning the member sessions', () => {
    const shared = membership()

    const rooms = roomsFromRoster(
      [
        source('radar', { rooms: [{ ...shared, session: 's-radar' }], v: 1 }),
        source('scout', { rooms: [{ ...shared, session: 's-scout' }], v: 1 })
      ],
      0
    )

    expect(rooms).toHaveLength(1)
    // The thing desktop could not do: a machine with empty localStorage knows
    // the room, its name, its roster AND where each member's side lives.
    expect(rooms[0].sessions).toEqual({ radar: 's-radar', scout: 's-scout' })
  })

  it('keeps a LOSING record’s session id — sessions are a union, not part of the LWW', () => {
    const shared = membership()

    const rooms = roomsFromRoster(
      [
        source('radar', { rooms: [{ ...shared, rev: 9, session: 's-radar' }], v: 1 }),
        source('scout', { rooms: [{ ...shared, rev: 1, session: 's-scout' }], v: 1 })
      ],
      0
    )

    expect(rooms[0].rev).toBe(9)
    expect(rooms[0].sessions.scout).toBe('s-scout')
  })

  it('does NOT let a snapshot fetched before a local write overlay it back', () => {
    // #disband-resurrection: the roster call was already in flight when the
    // user renamed the room. Its answer is older than the world.
    const known = [asRoom(membership({ name: 'Renamed', rev: 2, at: 500 }))]
    const stale = [asRoom(membership({ name: 'Ops', rev: 5, at: 400 }))]

    const merged = mergeRoomRecords(known, stale, { fetchedAt: 100, writtenAt: { r_aaa: 200 } })

    expect(merged[0].name).toBe('Renamed')
  })

  it('accepts a snapshot fetched AFTER the local write', () => {
    const known = [asRoom(membership({ name: 'Renamed', rev: 2 }))]
    const fresh = [asRoom(membership({ name: 'From another machine', rev: 5 }))]

    const merged = mergeRoomRecords(known, fresh, { fetchedAt: 900, writtenAt: { r_aaa: 200 } })

    expect(merged[0].name).toBe('From another machine')
  })

  it('cannot be resurrected by a stale peer once disbanded', () => {
    const tomb = disbandTombstone(membership({ rev: 4 }), 2_000)

    expect(tomb.disbanded).toBe(true)
    expect(tomb.rev).toBe(5)

    // A peer that missed the disband writes at its own, lower rev.
    const merged = mergeRoomRecords([asRoom(tomb)], [asRoom(membership({ rev: 4, name: 'Ops' }))], {
      fetchedAt: 9_999,
      writtenAt: {}
    })

    expect(merged[0].disbanded).toBe(true)
    expect(liveRooms(merged)).toEqual([])
  })

  it('re-forming a group under a taken name mints a NEW id rather than reopening the log', () => {
    const tomb = disbandTombstone(membership(), 2_000)
    const reformed = membership({ id: 'r_bbb', name: 'Ops' })

    const merged = mergeRoomRecords([asRoom(tomb)], [asRoom(reformed)], { fetchedAt: 9_999, writtenAt: {} })

    expect(liveRooms(merged).map(room => room.id)).toEqual(['r_bbb'])
  })

  it('converges after a PARTIAL write — 3 of 6 members accepted the rename', () => {
    const before = membership({ name: 'Ops', rev: 3 })
    const after = bumpRoom(before, { name: 'Ops v2' }, 2_000)

    // Three profiles took the write; three still carry the old record.
    const rooms = roomsFromRoster(
      [
        source('a', { rooms: [after], v: 1 }),
        source('b', { rooms: [after], v: 1 }),
        source('c', { rooms: [after], v: 1 }),
        source('d', { rooms: [before], v: 1 }),
        source('e', { rooms: [before], v: 1 }),
        source('f', { rooms: [before], v: 1 })
      ],
      0
    )

    expect(rooms[0].name).toBe('Ops v2')
    expect(rooms[0].rev).toBe(4)
  })
})

describe('v0 migration', () => {
  it('mints the SAME id on two clients migrating independently', () => {
    const meta: BotMeta = { groups: ['Ops'] }

    const a = migrateV0Memberships(meta, 'radar', 111)
    const b = migrateV0Memberships(meta, 'radar', 999)

    expect(a[0].id).toBe(b[0].id)
    expect(a[0].id).toBe(derivedRoomId('Ops', ['radar']))
    expect(a[0].id).toMatch(/^r_[0-9a-f]{12}$/)
    // rev 0, so ANY real v1 write beats the migration.
    expect(a[0].rev).toBe(0)
  })

  it('reads the v0 scalar `group` as well as the array', () => {
    expect(migrateV0Memberships({ group: 'Solo' }, 'radar', 0)).toHaveLength(1)
    expect(migrateV0Memberships({ group: null }, 'radar', 0)).toEqual([])
  })

  it('lets a v1 room with the same id win over its migrated v0 twin', () => {
    const id = derivedRoomId('Ops', ['radar'])
    const meta: BotMeta = { groups: ['Ops'], rooms: [membership({ id, name: 'Ops renamed', rev: 4 })], v: 1 }

    const rooms = roomsFromRoster([source('radar', meta)], 0)

    expect(rooms).toHaveLength(1)
    expect(rooms[0].name).toBe('Ops renamed')
  })

  it('leaves the v0 keys in place so a desktop client sharing the gateway keeps working', () => {
    const meta: BotMeta = { group: 'Ops', groups: ['Ops'] }
    const next = withRoom(meta, membership())

    expect(next.groups).toEqual(['Ops'])
    expect(next.group).toBe('Ops')
    expect(next.v).toBe(1)
  })
})

describe('room size limits are honest about the connection pool', () => {
  it('refuses more than six members', () => {
    const members = Array.from({ length: 7 }, (_, i) => member(`bot${i}`))

    expect(roomSizeRefusal(members)).toEqual({ limit: GROUP_CHAT_MAX_MEMBERS, reason: 'members' })
  })

  it('refuses more REMOTE members than the secondary-socket pool can lease', () => {
    const remote = Array.from({ length: 6 }, (_, i) => member(`bot${i}`, `conn-${i}`))

    // Six members is within the room cap — and still refused, because each of
    // the six needs its own secondary socket and the pool holds five. Silently
    // dropping the sixth mid-drive is the failure this prevents.
    expect(roomSizeRefusal(remote)).toEqual({ limit: MAX_REMOTE_MEMBERS, reason: 'remote' })
    // Five remote plus a local one is fine.
    expect(roomSizeRefusal([member('local'), ...remote.slice(0, 5)])).toBeNull()
  })

  it('keeps the remote cap pinned to MJXHRM-446’s real pool size', () => {
    // The plugin may not import `@/store/*`, so the number is duplicated. This
    // is the pin that stops the copy drifting.
    expect(MAX_REMOTE_MEMBERS).toBe(MAX_SECONDARIES)
  })
})

describe('record shaping', () => {
  it('gives each member its OWN session id in its own row', () => {
    const room = asRoom(membership(), { radar: 's-radar', scout: 's-scout' })

    expect(membershipFor(room, 'radar').session).toBe('s-radar')
    expect(membershipFor(room, 'scout').session).toBe('s-scout')
    expect('sessions' in membershipFor(room, 'radar')).toBe(false)
  })

  it('prunes only tombstones, oldest first, and never a live room', () => {
    const live = membership({ id: 'live' })
    const old = { ...disbandTombstone(membership({ id: 'old' }), 100), at: 100 }
    const recent = { ...disbandTombstone(membership({ id: 'recent' }), 900), at: 900 }

    expect(pruneTombstones([live, old, recent], 1).map(room => room.id)).toEqual(['live', 'recent'])
  })
})
