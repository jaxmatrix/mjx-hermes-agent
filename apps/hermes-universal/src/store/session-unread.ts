/**
 * PERSISTED UNREAD — the durable layer under the transient
 * `$unreadFinishedSessionIds` atom. Ported from desktop `store/session-unread.ts`
 * (which itself follows the webui's proven design: viewed-count watermarks +
 * completion markers).
 *
 * Two persisted records, both bucketed BY PROFILE and then keyed by the DURABLE
 * lineage id (`sessionPinId`) so state survives auto-compression's session-id
 * rotation — the same durable-id rule `$sessionColorOverrides` uses:
 *
 *  1. SEEN WATERMARKS — the `message_count` last acknowledged for a session
 *     (set when the user looks at it, kept current while it stays focused, and
 *     seeded on FIRST SIGHT of an unknown session so a fresh install doesn't
 *     paint every row green). A row whose live `message_count` exceeds its
 *     watermark is unread — this is what reconstructs the dot for a session
 *     that finished while the app was CLOSED, which the live busy→idle edge in
 *     session-states.ts can never replay after a restart.
 *
 *  2. EXPLICIT MARKERS — the live busy→idle edge, persisted. Covers the gap
 *     where a turn finishes in the background but the list hasn't refreshed its
 *     `message_count` yet (and any completion that adds no stored messages), so
 *     a restart right after a finish keeps the dot.
 *
 * PROFILE SCOPING is not optional: session ids are caller-supplied and each
 * remote-profile backend is its own namespace, so two profiles can hold the
 * same id — and the lists routinely mix profiles (messaging rows are ALWAYS
 * cross-profile, `$sessions` is too under ALL-profiles scope). Unscoped keys let
 * one profile's watermark paint (or silence) another's row. The bucket is always
 * the ROW's own `profile` (normalizeProfileKey, absent → "default"), never the
 * live gateway's — except for a live edge with no loaded row, which only ever
 * fires for the ACTIVE gateway's runtimes.
 *
 * UNIVERSAL DIFFERENCES from desktop, both deliberate:
 *  - "on screen" is `$focusedStoredSessionId` (the focused tile, else the
 *    selected session), not `$selectedStoredSessionId`. A tile is never the
 *    selection here — see session-unread-tile.test.ts.
 *  - There is no `$cronSessions` list; cron rows arrive inside `$sessions`.
 *
 * Both records are BOUNDED: markers cap per profile (oldest evicted), watermarks
 * cap in total (unlisted, unmarked entries dropped first), and deleting or
 * archiving a session drops its entries outright via {@link forgetSessionUnread}.
 *
 * Scope of watermark-based unread: chat rows. Messaging rows get their
 * `message_count` bumped by inbound human messages, so count-over-watermark
 * would paint "finished — unread" on every new inbound text; they keep only the
 * explicit live-edge markers (now persisted across restarts too).
 */

import { Codecs, persistentAtom } from '@/lib/persisted'
import { stableArray } from '@/lib/stable-array'
import { readKey } from '@/lib/storage'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import type { SessionInfo } from '@/types/hermes'

import {
  $messagingSessions,
  $sessions,
  $unreadFinishedSessionIds,
  sessionMatchesStoredId,
  sessionPinId,
  setUnreadPersistence
} from './session'
import { $focusedStoredSessionId } from './session-states'
import { isSecondaryWindow } from './windows'

/** profile key → durable id → last acknowledged message_count. */
type SeenCounts = Record<string, Record<string, number>>

/** profile key → durable ids flagged by the live busy→idle edge. */
type Markers = Record<string, string[]>

const SEEN_COUNTS_KEY = 'hermes.sessionSeenCounts'
const MARKERS_KEY = 'hermes.unreadFinishedSessions'

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// Also the migration: a pre-profile-scoping flat record (durable id → number)
// has non-object values, so it drops wholesale rather than mis-attributing every
// id to a profile named after it. Dropped watermarks reseed on next sight, which
// reads as "not unread" — the safe default.
function sanitizeSeenCounts(value: unknown): SeenCounts {
  if (!isPlainRecord(value)) {
    return {}
  }

  const next: SeenCounts = {}

  for (const [profile, bucket] of Object.entries(value)) {
    if (!isPlainRecord(bucket)) {
      continue
    }

    const counts = Object.fromEntries(
      Object.entries(bucket).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )
    )

    if (Object.keys(counts).length) {
      next[profile] = counts
    }
  }

  return next
}

// Same story for markers: the legacy flat shape was a bare string[], which is
// not an object of arrays, so it decodes to {}.
function sanitizeMarkers(value: unknown): Markers {
  if (!isPlainRecord(value)) {
    return {}
  }

  const next: Markers = {}

  for (const [profile, bucket] of Object.entries(value)) {
    if (!Array.isArray(bucket)) {
      continue
    }

    const ids = bucket.filter((id): id is string => typeof id === 'string' && id.length > 0)

    if (ids.length) {
      next[profile] = ids
    }
  }

  return next
}

export const $sessionSeenCounts = persistentAtom<SeenCounts>(SEEN_COUNTS_KEY, {}, Codecs.json(sanitizeSeenCounts))

export const $unreadFinishedMarkers = persistentAtom<Markers>(MARKERS_KEY, {}, Codecs.json(sanitizeMarkers))

// Watermarks accrete one entry per session ever seen; keep the record bounded.
// Past the cap, entries for sessions no longer in any loaded list (and not
// explicitly marked) are dropped — a pruned session reseeds on next sight, which
// reads as "not unread", the safe default.
const SEEN_COUNTS_CAP = 2000

// Markers only matter while their session still exists, and a marker whose
// session is gone is invisible (nothing paints it) but immortal — deletes we
// never observed (another client, a wiped backend) would accrete forever. Cap
// per profile and evict oldest-first: the freshest finishes are the ones the
// user still cares about.
const MARKERS_CAP = 200

const allRows = (): SessionInfo[] => [...$sessions.get(), ...$messagingSessions.get()]

const isOnScreen = (row: SessionInfo, focused: null | string): boolean =>
  Boolean(focused && sessionMatchesStoredId(row, focused))

/** The persistence bucket a row belongs to — its OWN profile, never the live
 *  gateway's (the lists are routinely cross-profile). */
const profileKeyForRow = (row: SessionInfo): string => normalizeProfileKey(row.profile)

/** The row a bare stored id refers to. Ids are caller-supplied and each profile's
 *  backend is its own namespace, so two profiles can hold the same id; a tie
 *  breaks toward the live gateway, since both opening a session and running one
 *  swap the gateway onto that session's profile. */
function resolveLoadedRow(storedSessionId: string): SessionInfo | undefined {
  const matches = allRows().filter(row => sessionMatchesStoredId(row, storedSessionId))

  if (matches.length < 2) {
    return matches[0]
  }

  const gateway = normalizeProfileKey($activeGatewayProfile.get())

  return matches.find(row => profileKeyForRow(row) === gateway) ?? matches[0]
}

/** Bucket for a bare stored id: its row's profile, else the live gateway's. */
const resolveProfile = (storedSessionId: string): string => {
  const row = resolveLoadedRow(storedSessionId)

  return row ? profileKeyForRow(row) : normalizeProfileKey($activeGatewayProfile.get())
}

/** Write a profile's marker bucket, dropping the key when it empties so we don't
 *  persist a graveyard of `[]`. */
function setMarkerBucket(profile: string, ids: readonly string[]): void {
  const markers = $unreadFinishedMarkers.get()
  const next = { ...markers }

  if (ids.length) {
    next[profile] = [...ids]
  } else {
    delete next[profile]
  }

  $unreadFinishedMarkers.set(next)
}

/** LIVE-EDGE WRITER — called by session-states.ts on a background busy→idle
 *  transition. Persists the marker so the dot survives a restart; the transient
 *  atom is written by the caller (immediate paint). The marker lands in the
 *  row's own profile; with no loaded row we use the active gateway's, which is
 *  the only place a live edge can come from. */
export function markSessionUnreadFinished(storedSessionId: string): void {
  const row = resolveLoadedRow(storedSessionId)
  const profile = row ? profileKeyForRow(row) : normalizeProfileKey($activeGatewayProfile.get())
  const durableId = row ? sessionPinId(row) : storedSessionId
  const bucket = $unreadFinishedMarkers.get()[profile] ?? []

  if (bucket.includes(durableId)) {
    return
  }

  const next = [...bucket, durableId]

  setMarkerBucket(profile, next.length > MARKERS_CAP ? next.slice(next.length - MARKERS_CAP) : next)
}

/** ACK — the user is looking at this session: watermark := its current
 *  message_count, and any explicit marker is retired. */
function ackSessionRow(row: SessionInfo): void {
  const profile = profileKeyForRow(row)
  const durableId = sessionPinId(row)

  if (Number.isFinite(row.message_count)) {
    const seen = $sessionSeenCounts.get()
    const bucket = seen[profile]

    if (bucket?.[durableId] !== row.message_count) {
      $sessionSeenCounts.set({ ...seen, [profile]: { ...bucket, [durableId]: row.message_count } })
    }
  }

  const markers = $unreadFinishedMarkers.get()[profile]

  if (!markers) {
    return
  }

  const next = markers.filter(id => id !== durableId && !sessionMatchesStoredId(row, id))

  if (next.length !== markers.length) {
    setMarkerBucket(profile, next)
  }
}

/** Clear persisted unread for a stored id even when its row isn't loaded — the
 *  marker alone can be retired; the watermark needs the row's count. With no row
 *  there is no profile to read, so we retire it from the active gateway's bucket
 *  (the profile whose sessions you can actually be opening); other profiles'
 *  identically-named ids stay untouched. */
export function ackStoredSessionId(storedSessionId: null | string): void {
  if (!storedSessionId) {
    return
  }

  const row = resolveLoadedRow(storedSessionId)

  if (row) {
    ackSessionRow(row)

    return
  }

  const profile = normalizeProfileKey($activeGatewayProfile.get())
  const markers = $unreadFinishedMarkers.get()[profile]

  if (!markers) {
    return
  }

  const next = markers.filter(id => id !== storedSessionId)

  if (next.length !== markers.length) {
    setMarkerBucket(profile, next)
  }
}

/** Sidebar "Mark all as read" — ack every LOADED row (watermark := its current
 *  count, markers retired) so the persisted layer doesn't repaint the dots the
 *  user just dismissed on the next list refresh. Rows not loaded keep their
 *  state: an unseen session in a collapsed profile stays honestly unread. */
export function ackAllSessionsRead(): void {
  for (const row of allRows()) {
    ackSessionRow(row)
  }
}

/** DELETE/ARCHIVE CLEANUP — the session is gone from the user's world, so its
 *  watermark and marker are dead weight. Drops every candidate id (stored id,
 *  live id, lineage root) from both persisted records in `profile`'s bucket and
 *  from the transient atom. Same-id sessions in other profiles survive. */
export function forgetSessionUnread(
  candidateIds: readonly (null | string | undefined)[],
  profile?: null | string
): void {
  const ids = new Set(candidateIds.filter((id): id is string => Boolean(id)))

  if (!ids.size) {
    return
  }

  const key = normalizeProfileKey(profile)
  const seen = $sessionSeenCounts.get()
  const counts = seen[key]

  if (counts) {
    const kept = Object.fromEntries(Object.entries(counts).filter(([id]) => !ids.has(id)))

    if (Object.keys(kept).length !== Object.keys(counts).length) {
      const next = { ...seen }

      if (Object.keys(kept).length) {
        next[key] = kept
      } else {
        delete next[key]
      }

      $sessionSeenCounts.set(next)
    }
  }

  const markers = $unreadFinishedMarkers.get()[key]

  if (markers) {
    const kept = markers.filter(id => !ids.has(id))

    if (kept.length !== markers.length) {
      setMarkerBucket(key, kept)
    }
  }

  const current = $unreadFinishedSessionIds.get()
  const nextIds = current.filter(id => !ids.has(id))

  if (nextIds.length !== current.length) {
    $unreadFinishedSessionIds.set(nextIds)
  }
}

/** Seed/refresh watermarks from freshly loaded lists: the FOCUSED session tracks
 *  its live count (it's on screen — nothing there is unread), and a session
 *  never seen before seeds at its current count instead of lighting up on first
 *  sight. Known, unfocused rows are left alone — the gap between their watermark
 *  and live count IS the unread signal. */
function ingestRows(rows: readonly SessionInfo[]): void {
  const focused = $focusedStoredSessionId.get()
  // Only the OWNING profile's row counts as on-screen: a same-id row in another
  // profile is a different session and keeps its unread gap.
  const focusedProfile = focused ? resolveProfile(focused) : null
  const seen = $sessionSeenCounts.get()
  let next: null | SeenCounts = null

  const write = (profile: string, durableId: string, count: number): void => {
    next ??= { ...seen }
    next[profile] = { ...next[profile], [durableId]: count }
  }

  for (const row of rows) {
    if (!Number.isFinite(row.message_count)) {
      continue
    }

    const profile = profileKeyForRow(row)
    const durableId = sessionPinId(row)
    const bucket = next?.[profile] ?? seen[profile]

    if (profile === focusedProfile && isOnScreen(row, focused)) {
      if (bucket?.[durableId] !== row.message_count) {
        write(profile, durableId, row.message_count)
      }

      // Any lingering explicit marker for the on-screen session is stale.
      const markers = $unreadFinishedMarkers.get()[profile]

      if (markers) {
        const kept = markers.filter(id => id !== durableId && !sessionMatchesStoredId(row, id))

        if (kept.length !== markers.length) {
          setMarkerBucket(profile, kept)
        }
      }
    } else if (!bucket || !(durableId in bucket)) {
      write(profile, durableId, row.message_count)
    }
  }

  if (next) {
    $sessionSeenCounts.set(pruneSeenCounts(next, rows))
  }
}

function pruneSeenCounts(seen: SeenCounts, rows: readonly SessionInfo[]): SeenCounts {
  const total = Object.values(seen).reduce((sum, bucket) => sum + Object.keys(bucket).length, 0)

  if (total <= SEEN_COUNTS_CAP) {
    return seen
  }

  const markers = $unreadFinishedMarkers.get()
  const keep = new Map<string, Set<string>>()

  const keepFor = (profile: string): Set<string> => {
    let ids = keep.get(profile)

    if (!ids) {
      ids = new Set(markers[profile] ?? [])
      keep.set(profile, ids)
    }

    return ids
  }

  for (const row of rows) {
    keepFor(profileKeyForRow(row)).add(sessionPinId(row))
  }

  const next: SeenCounts = {}

  for (const [profile, bucket] of Object.entries(seen)) {
    const allowed = keepFor(profile)
    const kept = Object.fromEntries(Object.entries(bucket).filter(([id]) => allowed.has(id)))

    if (Object.keys(kept).length) {
      next[profile] = kept
    }
  }

  return next
}

/** Recompute the transient unread atom from persisted state + loaded rows. Runs
 *  after every list refresh — including the first one after a cold start, which
 *  is what brings the dots back from a restart. Stored ids already flagged by the
 *  live edge but not (yet) present in any list — a brand-new session's first turn
 *  isn't flushed to the list until persisted — are preserved, not dropped. */
function recomputeUnread(): void {
  const focused = $focusedStoredSessionId.get()
  const markers = $unreadFinishedMarkers.get()
  const seen = $sessionSeenCounts.get()
  const unread: string[] = []

  const isMarked = (row: SessionInfo, durableId: string): boolean => {
    const bucket = markers[profileKeyForRow(row)]

    return Boolean(bucket?.includes(durableId) || bucket?.includes(row.id))
  }

  // Watermark + marker unread for chat rows. The on-screen skip stays
  // profile-blind here (unlike the persisted writes): the paint layer is keyed by
  // row id, so dotting a same-id row from another profile would just put a dot on
  // the session you have open.
  for (const row of $sessions.get()) {
    if (isOnScreen(row, focused)) {
      continue
    }

    const durableId = sessionPinId(row)
    const watermark = seen[profileKeyForRow(row)]?.[durableId]

    const exceedsWatermark =
      typeof watermark === 'number' && Number.isFinite(row.message_count) && row.message_count > watermark

    if (exceedsWatermark || isMarked(row, durableId)) {
      unread.push(row.id)
    }
  }

  // Messaging rows: explicit (live-edge) markers only — see the header comment.
  for (const row of $messagingSessions.get()) {
    if (!isOnScreen(row, focused) && isMarked(row, sessionPinId(row))) {
      unread.push(row.id)
    }
  }

  // Preserve live-edge ids whose row isn't loaded yet.
  const loadedRows = allRows()

  for (const id of $unreadFinishedSessionIds.get()) {
    if (id !== focused && !unread.includes(id) && !loadedRows.some(row => sessionMatchesStoredId(row, id))) {
      unread.push(id)
    }
  }

  const current = $unreadFinishedSessionIds.get()
  const next = stableArray(current, unread)

  if (next !== current) {
    $unreadFinishedSessionIds.set([...next])
  }
}

// COLD-BOOT REHYDRATE — module evaluation can race the webview's storage-area
// load: an early read comes back empty, the atoms seed their fallbacks, and the
// first ingest would then re-seed every row and write that emptiness back over
// the real record. By the time the first session list arrives (seconds later,
// over the gateway) storage is reliably readable, so re-read both keys once right
// before the first ingest and adopt the disk state, keeping any entry this window
// already wrote in the meantime (a live edge or an ack beats the stale disk copy
// for its own key).
let rehydratedFromDisk = false

function rehydrateFromDiskOnce(): void {
  if (rehydratedFromDisk) {
    return
  }

  rehydratedFromDisk = true

  try {
    const rawSeen = readKey(SEEN_COUNTS_KEY)
    const diskSeen = rawSeen ? sanitizeSeenCounts(JSON.parse(rawSeen) as unknown) : {}
    const memorySeen = $sessionSeenCounts.get()
    const mergedSeen: SeenCounts = { ...diskSeen }

    for (const [profile, bucket] of Object.entries(memorySeen)) {
      mergedSeen[profile] = { ...mergedSeen[profile], ...bucket }
    }

    $sessionSeenCounts.set(mergedSeen)

    const rawMarkers = readKey(MARKERS_KEY)
    const diskMarkers = rawMarkers ? sanitizeMarkers(JSON.parse(rawMarkers) as unknown) : {}
    const memoryMarkers = $unreadFinishedMarkers.get()
    const merged: Markers = { ...diskMarkers }

    for (const [profile, ids] of Object.entries(memoryMarkers)) {
      merged[profile] = [...new Set([...(merged[profile] ?? []), ...ids])]
    }

    $unreadFinishedMarkers.set(merged)
  } catch {
    // Unreadable storage: keep the in-memory state — the same fallback the atoms
    // started from.
  }
}

function onListChange(): void {
  rehydrateFromDiskOnce()
  ingestRows(allRows())
  recomputeUnread()
}

/** Wire the persisted layer to the session lists. Called once at boot.
 *
 *  ONLY the primary window maintains the persisted records: a secondary window
 *  (single-chat pop-out, HUD, satellite) sees a sliver of the lists, and letting
 *  it seed/ack against that partial view would clobber the primary's whole-record
 *  writes — the same isolation rule as the persisted session tiles. */
export function watchPersistedUnread(): void {
  if (isSecondaryWindow()) {
    return
  }

  setUnreadPersistence({
    ackAll: ackAllSessionsRead,
    forget: forgetSessionUnread,
    markFinished: markSessionUnreadFinished
  })

  $sessions.listen(onListChange)
  $messagingSessions.listen(onListChange)

  // Looking at a session acks it durably (the transient atom is already cleared
  // synchronously by the focus listener in session-states.ts — this is the
  // persisted half).
  $focusedStoredSessionId.listen(ackStoredSessionId)
}
