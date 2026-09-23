/**
 * `ui_meta['hermes-bots']` — the DURABLE record, and the only server truth Bot
 * Mode has.
 *
 * It rides `profiles.configure({uiMeta})`, which merges KEY-WISE server-side
 * and deletes a key set to `null`. The whole `ui_meta` dict is capped at 64 KB
 * and answers `applied.ui_meta: false` past that, so nothing here is ever an
 * image and everything here is small.
 *
 * Client-owned: the backend only checks it is a dict. `v` is therefore the
 * migration lane — a future shape lands without a backend change, and desktop's
 * v0 (no `v`, `groups: string[]` of NAMES) is read, migrated and LEFT IN PLACE
 * so a desktop client sharing the gateway keeps working.
 */

export const BOT_META_KEY = 'hermes-bots'

/** Soft refusal point for one profile's `hermes-bots` JSON. The backend's hard
 *  cap is 64 KB for the WHOLE `ui_meta` dict, which we share with any other
 *  client's keys — refusing at 48 KB is what turns "your write silently did
 *  nothing" into a message the user can act on. */
export const BOT_META_MAX_BYTES = 48 * 1024

/** One room this bot belongs to, replicated to EVERY member's profile — which
 *  is what makes the whole roster reconstructible from `profiles.list` alone. */
export interface RoomMembership {
  id: string
  /** Monotonic. Last-writer-wins on `(rev, at)`. */
  rev: number
  /** ms epoch of that rev — the tiebreak when two clients write the same rev. */
  at: number
  name: string
  members: RoomMemberRef[]
  /** THIS bot's `Group: <name>` stored session id. */
  session?: null | string
  threads?: RoomThread[]
  /** A TOMBSTONE, never a deletion: a peer that missed the disband and later
   *  writes at a lower rev cannot resurrect the room. */
  disbanded?: true
}

export interface RoomMemberRef {
  profile: string
  /** MJXHRM-446 connection id; absent means the local/primary connection. */
  connectionId?: string
  /** The @tag as of the last write. A rename re-resolves; this is a hint, not
   *  an identity. */
  handle: string
}

export interface RoomThread {
  id: string
  title: string
  at: number
}

export interface BotMeta {
  /** Absent means desktop's v0 shape. */
  v?: number
  shape?: string
  color?: string
  /** A custom avatar asset is in use; the BYTES live in `profiles.set_asset`. */
  imageKind?: 'photo'
  title?: string
  custom?: boolean
  created?: number
  // NO `chat` KEY, AND NOT AGAIN. A bot's canonical chat is identified by the
  // pair (profile, session titled exactly "Bot Chat") — a registry the unique
  // title index already enforces. A stored id here is a SECOND identity that
  // can disagree with the first, and every way it disagreed forked a bot's
  // memory. Not as a cache, not as a fallback tier, not "for verification".
  //
  // Records written by older clients still carry the key; `decodeBotMeta`
  // simply does not read it, so it falls out of the record on the next
  // ordinary write and needs no migration.
  pinned?: boolean
  /** Roster visibility. Never written as `null`, because `null` DELETES the key
   *  server-side and a deleted `hidden` reads as "not hidden" — which is the
   *  opposite of what a user unhiding-by-accident would expect to be durable. */
  hidden?: boolean
  /** v0 membership, by room NAME. Read and migrated; never written. */
  groups?: string[]
  /** v0 scalar (= `groups[0] ?? null`). Read-only. */
  group?: null | string
  /** v1 membership, by room ID. The write path. */
  rooms?: RoomMembership[]
}

export const BOT_META_VERSION = 1

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

function decodeMemberRef(raw: unknown): null | RoomMemberRef {
  if (!isRecord(raw)) {
    return null
  }

  const profile = str(raw.profile)

  if (!profile) {
    return null
  }

  return {
    ...(str(raw.connectionId) ? { connectionId: str(raw.connectionId)! } : {}),
    handle: str(raw.handle) ?? profile,
    profile
  }
}

function decodeThread(raw: unknown): null | RoomThread {
  if (!isRecord(raw)) {
    return null
  }

  const id = str(raw.id)

  return id ? { at: num(raw.at) ?? 0, id, title: str(raw.title) ?? '' } : null
}

/** Threads per room. The record shares a 64 KB budget with every other key on
 *  the profile, and desktop had no cap at all. */
export const MAX_ROOM_THREADS = 16

export function decodeMembership(raw: unknown): null | RoomMembership {
  if (!isRecord(raw)) {
    return null
  }

  const id = str(raw.id)

  if (!id) {
    return null
  }

  const members = Array.isArray(raw.members)
    ? raw.members.map(decodeMemberRef).filter((m): m is RoomMemberRef => m !== null)
    : []

  const threads = Array.isArray(raw.threads)
    ? raw.threads
        .map(decodeThread)
        .filter((t): t is RoomThread => t !== null)
        .slice(-MAX_ROOM_THREADS)
    : undefined

  return {
    at: num(raw.at) ?? 0,
    ...(raw.disbanded === true ? { disbanded: true as const } : {}),
    id,
    members,
    name: str(raw.name) ?? id,
    rev: num(raw.rev) ?? 0,
    ...(raw.session === null || str(raw.session) ? { session: str(raw.session) ?? null } : {}),
    ...(threads ? { threads } : {})
  }
}

/**
 * Read one profile row's `ui_meta['hermes-bots']`, tolerating every shape a
 * gateway can actually hand back — including a `null`, a string, and desktop's
 * v0. An unparseable value yields an EMPTY meta rather than throwing: one
 * corrupt profile must not blank the roster.
 */
export function decodeBotMeta(uiMeta: unknown): BotMeta {
  const container = isRecord(uiMeta) ? uiMeta[BOT_META_KEY] : undefined

  if (!isRecord(container)) {
    return {}
  }

  const rooms = Array.isArray(container.rooms)
    ? container.rooms.map(decodeMembership).filter((r): r is RoomMembership => r !== null)
    : undefined

  return {
    ...(str(container.color) ? { color: str(container.color) } : {}),
    ...(typeof container.created === 'number' ? { created: container.created } : {}),
    ...(container.custom === true ? { custom: true } : {}),
    ...(str(container.group) || container.group === null ? { group: str(container.group) ?? null } : {}),
    ...(Array.isArray(container.groups)
      ? { groups: container.groups.filter((g): g is string => typeof g === 'string') }
      : {}),
    ...(typeof container.hidden === 'boolean' ? { hidden: container.hidden } : {}),
    ...(container.imageKind === 'photo' ? { imageKind: 'photo' as const } : {}),
    ...(typeof container.pinned === 'boolean' ? { pinned: container.pinned } : {}),
    ...(rooms ? { rooms } : {}),
    ...(str(container.shape) ? { shape: str(container.shape) } : {}),
    ...(str(container.title) ? { title: str(container.title) } : {}),
    ...(num(container.v) ? { v: num(container.v) } : {})
  }
}

/** The wire size of one profile's record, for the soft cap. */
export const botMetaBytes = (meta: BotMeta): number => new TextEncoder().encode(JSON.stringify(meta)).length

/**
 * How a `profiles.configure` write actually landed.
 *
 * `applied.ui_meta === false` means the backend REFUSED (over 64 KB); an ABSENT
 * key means an older gateway that does not report per-section results at all.
 * Those are different answers and desktop's `bot-meta-persistence.test.mjs`
 * exists because collapsing them told a user their settings had failed when the
 * gateway simply could not say.
 */
export type BotMetaWriteOutcome = 'persisted' | 'rejected' | 'unsupported'

export function classifyWrite(result: { applied?: Record<string, boolean | undefined> }): BotMetaWriteOutcome {
  const applied = result.applied

  if (!applied || !('ui_meta' in applied)) {
    return 'unsupported'
  }

  return applied.ui_meta === true ? 'persisted' : 'rejected'
}
