/**
 * The ROOM MODEL — pure, and the reason universal's rooms have server truth
 * where desktop's did not.
 *
 * Desktop kept group rooms in `ctx.storage['group-chats']` alone: two desktops
 * on the "same" group saw different logs, and clearing storage lost the room
 * while its member sessions lived on. Here a room record is REPLICATED into
 * `ui_meta['hermes-bots'].rooms` on EVERY member profile, so the whole roster
 * reconstructs from one `profiles.list` — from a machine that has never seen
 * the room before.
 *
 * The price of replication is conflict, and the answer is last-writer-wins on
 * `(rev, at)` plus two guards nothing else provides:
 *
 *  - a DISBAND writes a tombstone, never a deletion, so a peer that missed it
 *    and later writes at a lower rev cannot resurrect the room;
 *  - a snapshot FETCHED BEFORE a local write cannot overlay that write back
 *    (desktop's `#disband-resurrection`), which is what `fetchedAt` is for.
 *
 * Every function here is pure. The stores call them; nothing in this file
 * touches the network, the clock or storage.
 */

import { botHandle, derivedRoomId, groupMemberKey, MAIN_THREAD } from '../ids'

import { type BotMeta, decodeBotMeta, MAX_ROOM_THREADS, type RoomMemberRef, type RoomMembership } from './meta'

/** A room as the UI sees it: one merged record plus every member's session. */
export interface Room extends RoomMembership {
  /** memberKey → that member's `Group: <name>` stored session id (or null). */
  sessions: Record<string, null | string>
}

/** One profile row, as much of it as this model needs. */
export interface RosterMetaSource {
  profile: string
  connectionId?: string
  meta: BotMeta
}

/** The maximum members in a room.
 *
 *  Six is desktop's number and it also happens to be the ceiling MJXHRM-446's
 *  secondary-socket pool can serve: a room whose members live on N OTHER
 *  connections needs N distinct leases and the pool caps at 5, so at most five
 *  members may be remote. `roomSizeRefusal` below is the honest half of that. */
export const GROUP_CHAT_MAX_MEMBERS = 6

/** MJXHRM-446's `MAX_SECONDARIES`. Duplicated as a NUMBER rather than imported
 *  because the plugin may not reach `@/store/*` — `rooms.test.ts` pins the two
 *  together so a change on either side is caught. */
export const MAX_REMOTE_MEMBERS = 5

/**
 * Why a proposed roster cannot be a room — or null when it can.
 *
 * Stated up front rather than discovered mid-drive: a room that silently drops
 * its sixth remote member when the connection pool evicts a lease is exactly
 * the failure the user cannot diagnose.
 */
export function roomSizeRefusal(members: readonly RoomMemberRef[]): null | { limit: number; reason: 'members' | 'remote' } {
  if (members.length > GROUP_CHAT_MAX_MEMBERS) {
    return { limit: GROUP_CHAT_MAX_MEMBERS, reason: 'members' }
  }

  const remote = members.filter(member => Boolean(member.connectionId)).length

  return remote > MAX_REMOTE_MEMBERS ? { limit: MAX_REMOTE_MEMBERS, reason: 'remote' } : null
}

/** LWW: higher `rev` wins; equal `rev` breaks on the newer `at`. */
export function newerMembership(a: RoomMembership, b: RoomMembership): RoomMembership {
  if (a.rev !== b.rev) {
    return a.rev > b.rev ? a : b
  }

  return a.at >= b.at ? a : b
}

/**
 * Desktop's v0 shape → v1 memberships.
 *
 * v0 keyed a room by its NAME (`groups: string[]`), which is why a rename there
 * had to re-key the room, its memberships and its watermarks. The id is DERIVED
 * from the name and the sorted member list so two clients migrating the same
 * desktop room independently mint the SAME id — a random id would fork one room
 * into two the moment a second client opened it.
 *
 * `rev: 0` so any real v1 write wins immediately, and the v0 keys are left
 * untouched by the caller: a desktop client sharing this gateway still reads
 * them.
 */
export function migrateV0Memberships(meta: BotMeta, self: string, at: number): RoomMembership[] {
  const names = meta.groups ?? (meta.group ? [meta.group] : [])

  return names.map(name => ({
    at,
    id: derivedRoomId(name, [self]),
    members: [{ handle: botHandle(self), profile: self }],
    name,
    rev: 0
  }))
}

/** v1 rooms ∪ migrated v0 rooms, v1 winning on a collision. */
export function normalizeMemberships(meta: BotMeta, self: string, at: number): RoomMembership[] {
  const v1 = meta.rooms ?? []
  const known = new Set(v1.map(room => room.id))

  return [...v1, ...migrateV0Memberships(meta, self, at).filter(room => !known.has(room.id))]
}

/**
 * Rebuild every room from a roster snapshot.
 *
 * This is the function that makes a second machine with empty localStorage see
 * the same rooms: nothing but `profiles.list` goes in.
 */
export function roomsFromRoster(sources: readonly RosterMetaSource[], at: number): Room[] {
  const byId = new Map<string, Room>()

  for (const source of sources) {
    for (const membership of normalizeMemberships(source.meta, source.profile, at)) {
      const prev = byId.get(membership.id)
      const winner = prev ? newerMembership(membership, prev) : membership

      // Sessions are a UNION across members, not part of the LWW: each member
      // owns its own `Group:` session id, and the losing record still carries
      // the only copy of the one it owns.
      const sessions = { ...(prev?.sessions ?? {}) }

      sessions[groupMemberKey(source.profile, source.connectionId)] = membership.session ?? null

      byId.set(membership.id, { ...winner, sessions })
    }
  }

  return [...byId.values()]
}

/** Live rooms only — a tombstone stays in the record and out of the UI. */
export const liveRooms = (rooms: readonly Room[]): Room[] => rooms.filter(room => room.disbanded !== true)

/**
 * Merge an INCOMING roster snapshot over what is already known.
 *
 * The `fetchedAt` fence is the whole point. A `profiles.list` in flight while
 * the user disbands a room answers with the pre-disband record; overlaying it
 * would resurrect the room, which is desktop's `#disband-resurrection` bug.
 * A room whose local record was written AFTER the snapshot was fetched keeps
 * the local record, whatever the revs say.
 */
export function mergeRoomRecords(
  known: readonly Room[],
  incoming: readonly Room[],
  options: { fetchedAt: number; writtenAt: Readonly<Record<string, number>> }
): Room[] {
  const byId = new Map(known.map(room => [room.id, room]))

  for (const room of incoming) {
    const prev = byId.get(room.id)

    if (!prev) {
      byId.set(room.id, room)

      continue
    }

    const localWrite = options.writtenAt[room.id]

    if (localWrite !== undefined && localWrite > options.fetchedAt) {
      // The snapshot predates our own write: it cannot know about it, so it
      // does not get a vote on the record — only on the session ids, which are
      // a per-member union and cannot conflict.
      byId.set(room.id, { ...prev, sessions: { ...room.sessions, ...prev.sessions } })

      continue
    }

    const winner = newerMembership(room, prev)

    byId.set(room.id, { ...winner, sessions: { ...prev.sessions, ...room.sessions } })
  }

  return [...byId.values()]
}

/** The next revision of a room, ready to write to every member. */
export function bumpRoom(room: RoomMembership, patch: Partial<RoomMembership>, at: number): RoomMembership {
  return { ...room, ...patch, at, rev: room.rev + 1 }
}

/**
 * The record a DISBAND writes — a tombstone, deliberately still carrying its
 * members so a peer merging it can tell which profiles to stop showing it on.
 */
export function disbandTombstone(room: RoomMembership, at: number): RoomMembership {
  return { at, disbanded: true, id: room.id, members: room.members, name: room.name, rev: room.rev + 1 }
}

/** Rename is one field, because the id is not the name. */
export const renameRoom = (room: RoomMembership, name: string, at: number): RoomMembership =>
  bumpRoom(room, { name }, at)

/**
 * The membership row written to ONE member's profile.
 *
 * Each member stores the SHARED record plus its OWN session id — which is why
 * `session` is stripped from the shared half and re-attached per member here.
 */
export function membershipFor(room: Room, memberKey: string): RoomMembership {
  const { sessions: _sessions, ...shared } = room

  return { ...shared, session: room.sessions[memberKey] ?? null }
}

/** Merge a room's rows back into one profile's `BotMeta`, v0 keys untouched. */
export function withRoom(meta: BotMeta, membership: RoomMembership): BotMeta {
  const rooms = (meta.rooms ?? []).filter(room => room.id !== membership.id)

  return { ...meta, rooms: [...rooms, membership], v: 1 }
}

/**
 * Prune tombstones once the record is under size pressure.
 *
 * Oldest first, and only tombstones: a live room is never dropped to make
 * space. Keeping SOME tombstones is what stops a stale peer resurrecting a
 * room, so this runs only when the record would otherwise be refused.
 */
export function pruneTombstones(rooms: readonly RoomMembership[], keep: number): RoomMembership[] {
  const live = rooms.filter(room => room.disbanded !== true)
  const dead = rooms.filter(room => room.disbanded === true).sort((a, b) => b.at - a.at)

  return [...live, ...dead.slice(0, keep)]
}

/** A room's thread list, capped and newest-last. `main` is implicit. */
export function withThread(room: RoomMembership, thread: { at: number; id: string; title: string }): RoomMembership {
  if (thread.id === MAIN_THREAD) {
    return room
  }

  const threads = (room.threads ?? []).filter(existing => existing.id !== thread.id)

  return { ...room, threads: [...threads, thread].slice(-MAX_ROOM_THREADS) }
}

/** Read a roster row into the shape `roomsFromRoster` takes. */
export const rosterMetaSource = (row: { name: string; ui_meta?: unknown }, connectionId?: string): RosterMetaSource => ({
  ...(connectionId ? { connectionId } : {}),
  meta: decodeBotMeta(row.ui_meta),
  profile: row.name
})
