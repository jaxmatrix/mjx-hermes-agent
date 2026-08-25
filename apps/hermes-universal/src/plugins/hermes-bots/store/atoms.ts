/**
 * Bot Mode's reactive state. Plain nanostores, no React — so the driver, the
 * stores and any future mobile shell read the same values.
 *
 * Everything persisted here is a CACHE and is bounded, because
 * `lib/persist.ts` swallows `QuotaExceededError`: an unbounded write fails
 * INVISIBLY, and the only safe answer is that nothing correctness-bearing lives
 * in localStorage. The room record, the memberships and the member session ids
 * all come back from `profiles.list`; what is cached here is paint speed and
 * cosmetics.
 */

import { atom, type PluginStorage } from '@hermes/plugin-sdk'

import type { StrandedMarker } from '../driver/rounds'
import type { PauseReason } from '../driver/types'
import type { Room } from '../model/rooms'
import type { RosterRow } from '../model/roster'
import type { RoomLog } from '../model/transcript'

// ── live state ──────────────────────────────────────────────────────────────

export const $roster = atom<readonly RosterRow[]>([])
export const $rooms = atom<readonly Room[]>([])
export const $selectedBot = atom<null | string>(null)
export const $rosterLoading = atom(false)
export const $rosterError = atom<null | string>(null)

/** `profiles.list` said the gateway injects the teammate protocol itself.
 *  ABSENT means it does not — and the UI says so rather than writing the
 *  protocol into a user's SOUL.md, which is what desktop did. */
export const $botProtocolSupported = atom<boolean>(false)

/** Runtime state per room. Reset on load: a half-finished drive must not be
 *  able to resurrect itself from a cache. */
export interface RoomRuntime {
  /** Bumped SYNCHRONOUSLY by a user send, before any await. */
  epoch: number
  running: boolean
  /** memberKey currently thinking. */
  turn: null | string
  paused: null | PauseReason
  thread: string
  error: null | string
}

export const $roomRuntime = atom<Readonly<Record<string, RoomRuntime>>>({})

export const roomRuntime = (roomId: string): RoomRuntime =>
  $roomRuntime.get()[roomId] ?? { epoch: 1, error: null, paused: null, running: false, thread: 'main', turn: null }

export function patchRoomRuntime(roomId: string, patch: Partial<RoomRuntime>): RoomRuntime {
  const next = { ...roomRuntime(roomId), ...patch }

  $roomRuntime.set({ ...$roomRuntime.get(), [roomId]: next })

  return next
}

/** Bump a room's epoch. Synchronous by contract — a drive that awaits before
 *  this runs would not see the supersede. */
export const bumpEpoch = (roomId: string): number => patchRoomRuntime(roomId, { epoch: roomRuntime(roomId).epoch + 1 }).epoch

/** The derived transcript, per room. Never authority (§6.2). */
export const $roomLogs = atom<Readonly<Record<string, RoomLog>>>({})

export function setRoomLog(roomId: string, log: RoomLog): void {
  $roomLogs.set({ ...$roomLogs.get(), [roomId]: log })
}

/** A bounded feed for the room's activity strip. */
export interface ActivityEntry {
  at: number
  roomId: string
  text: string
}

export const ACTIVITY_LIMIT = 64
export const $activity = atom<readonly ActivityEntry[]>([])

export const pushActivity = (entry: ActivityEntry): void =>
  $activity.set([...$activity.get(), entry].slice(-ACTIVITY_LIMIT))

// ── persisted caches ────────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  activityToasts: 'activity-toasts',
  roomImage: 'room-image',
  rooms: 'rooms.v1',
  showHidden: 'show-hidden',
  stranded: 'stranded.v1',
  watermarks: 'watermarks.v1'
} as const

/** Bounds, all of them enforced on WRITE. */
export const CACHE_BOUNDS = {
  /** ≤128 KB per picture, ≤8 pictures — the `lib/thumb-cache.ts` precedent. */
  roomImageBytes: 128 * 1024,
  roomImages: 8,
  /** Stranded markers per room. They persist on purpose: a late reply must
   *  survive a window reload, or the member's answer is lost for good. */
  strandedPerRoom: 6
} as const

export interface PersistedRoomState {
  /** Which thread the user was last looking at. */
  thread?: string
  /** Fold state per member card. */
  expanded?: string[]
}

export const $showHidden = atom(false)
export const $activityToasts = atom(false)

/** `roomId -> memberKey -> marker`. Persisted (§6.3). */
export const $stranded = atom<Readonly<Record<string, Record<string, StrandedMarker>>>>({})

/** `roomId -> "<thread>::<memberKey>" -> at`. A CACHE — the authority is the
 *  member's own session (§8.3), and a disagreement drops the cache. */
export const $watermarks = atom<Readonly<Record<string, Record<string, number>>>>({})

/** Device-local room pictures. There is no server carrier: `profiles.set_asset`
 *  takes only `avatar`, and only for a profile (§6.4). The picker row says so. */
export const $roomImages = atom<Readonly<Record<string, string>>>({})

/**
 * Hydrate every cache from `ctx.storage`.
 *
 * A write that landed BEFORE hydration finished WINS: a slow load must never
 * wipe a pin the user set this session (desktop's `bot-meta-hydrate` invariant).
 * That is why each atom is merged into rather than overwritten.
 */
export function hydrateCaches(storage: PluginStorage): void {
  const merge = <T extends object>(current: T, stored: T): T => ({ ...stored, ...current })

  $stranded.set(merge($stranded.get(), storage.get(STORAGE_KEYS.stranded, {})))
  $watermarks.set(merge($watermarks.get(), storage.get(STORAGE_KEYS.watermarks, {})))
  $roomImages.set(merge($roomImages.get(), storage.get(STORAGE_KEYS.roomImage, {})))
  $showHidden.set(storage.get(STORAGE_KEYS.showHidden, false))
  $activityToasts.set(storage.get(STORAGE_KEYS.activityToasts, false))
}

/**
 * Persist the caches, trailing-edge throttled.
 *
 * 400 ms, the `inflight-turn-journal.ts` precedent: a room turn writes
 * watermarks on every member, and a synchronous write per member would put a
 * JSON serialise on the drive's hot path.
 */
export function watchCaches(storage: PluginStorage): () => void {
  let timer: null | ReturnType<typeof setTimeout> = null

  const flush = () => {
    timer = null
    storage.set(STORAGE_KEYS.stranded, capStranded($stranded.get()))
    storage.set(STORAGE_KEYS.watermarks, $watermarks.get())
    storage.set(STORAGE_KEYS.roomImage, $roomImages.get())
    storage.set(STORAGE_KEYS.showHidden, $showHidden.get())
    storage.set(STORAGE_KEYS.activityToasts, $activityToasts.get())
  }

  const schedule = () => {
    if (timer === null) {
      timer = setTimeout(flush, 400)
    }
  }

  const stops = [$stranded, $watermarks, $roomImages, $showHidden, $activityToasts].map(store =>
    store.listen(schedule)
  )

  return () => {
    stops.forEach(stop => stop())

    if (timer !== null) {
      clearTimeout(timer)
      // Android kills the process without warning (00-architecture §3.4), so a
      // pending write is flushed on the way out rather than dropped.
      flush()
    }
  }
}

/** Keep only the newest markers per room. */
export function capStranded(
  all: Readonly<Record<string, Record<string, StrandedMarker>>>
): Record<string, Record<string, StrandedMarker>> {
  const out: Record<string, Record<string, StrandedMarker>> = {}

  for (const [roomId, markers] of Object.entries(all)) {
    const newest = Object.entries(markers)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, CACHE_BOUNDS.strandedPerRoom)

    if (newest.length > 0) {
      out[roomId] = Object.fromEntries(newest)
    }
  }

  return out
}

/** Store a room picture, bounded. Refuses rather than silently dropping the
 *  oldest without saying so — the UI reports the refusal. */
export function putRoomImage(roomId: string, dataUrl: string): boolean {
  if (dataUrl.length > CACHE_BOUNDS.roomImageBytes) {
    return false
  }

  const current = { ...$roomImages.get(), [roomId]: dataUrl }
  const keys = Object.keys(current)

  // LRU by insertion: the oldest entry goes when the cap is reached.
  while (keys.length > CACHE_BOUNDS.roomImages) {
    delete current[keys.shift()!]
  }

  $roomImages.set(current)

  return true
}

export const watermarkKey = (thread: string, memberKey: string): string => `${thread}::${memberKey}`

export function setWatermark(roomId: string, thread: string, memberKey: string, at: number): void {
  const room = { ...($watermarks.get()[roomId] ?? {}), [watermarkKey(thread, memberKey)]: at }

  $watermarks.set({ ...$watermarks.get(), [roomId]: room })
}

export const readWatermark = (roomId: string, thread: string, memberKey: string): number =>
  $watermarks.get()[roomId]?.[watermarkKey(thread, memberKey)] ?? 0

export function setStranded(roomId: string, memberKey: string, marker: null | StrandedMarker): void {
  const room = { ...($stranded.get()[roomId] ?? {}) }

  if (marker) {
    room[memberKey] = marker
  } else {
    delete room[memberKey]
  }

  $stranded.set({ ...$stranded.get(), [roomId]: room })
}

export const readStranded = (roomId: string, memberKey: string): StrandedMarker | undefined =>
  $stranded.get()[roomId]?.[memberKey]
