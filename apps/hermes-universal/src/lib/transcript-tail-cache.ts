/**
 * The durable transcript TAIL cache: the last screen of a conversation, kept in
 * localStorage so a cold launch can paint it before the socket is up.
 *
 * WHY IT EXISTS. Universal's first paint after a relaunch is
 * `GatewayConnectingScreen`, and it stays there for the whole dial — a WAN
 * round trip, an SSH spawn (45-90 s), or, offline, forever. The transcript the
 * user was reading a moment ago is entirely recoverable from the backend and
 * entirely unavailable until it answers. This is a picture of it.
 *
 * WHAT IT IS NOT. It is a CACHE of rows the backend still holds, never a source
 * of truth: nothing here is ever reconciled, journaled, narrated, branched or
 * submitted from — see `store/transcript-paint.ts` for the lane that keeps that
 * structural rather than a rule.
 *
 * SHAPE — the `lib/inflight-turn-journal.ts` pattern, for the same reasons:
 *
 *  - ONE KEY PER SESSION. A corrupt entry can only destroy itself. The
 *    counter-example is in this repo: `lib/persisted.ts`'s decode fallback
 *    writes the DEFAULT back over a blob that failed to decode, so one bad byte
 *    in `$lastSessionByProfile` erases every profile's remembered chat. A single
 *    blob here would do the same to every cached transcript, which is why this
 *    deliberately does not use `persistentAtom`.
 *  - THE KEYSPACE IS THE TRUTH, the index is a hint. Eviction, housekeeping and
 *    the wipe all work from a `store.key(i)` prefix scan, so a missing,
 *    truncated or hand-edited index costs an LRU ORDERING, never an entry — and
 *    is never a reason to delete one.
 *  - BOUNDED ON BYTES AS WELL AS COUNT. Desktop bounds count only (50 × 256 KiB
 *    = a 12 MiB worst case); WebKitGTK gives an origin ~5 MB, and this app
 *    already spends quota on the crash journal and the pet thumb cache.
 *  - VERSIONED BY PREFIX, and a v2 keyspace DROPS v1 rather than migrating it.
 *    The journal migrates because it is the only copy of its data; a transcript
 *    tail is a cache of rows the backend still has, so a migration would be code
 *    written to avoid one loader.
 *
 * Pure except `localStorage`: no store imports, no React, no I/O. Quota failures
 * and a blocked-storage origin are REPORTED (`TailSaveResult`,
 * `transcriptTailCacheStatus`) rather than swallowed — the house rule is that
 * anything which can silently fail says what actually happened.
 */

import { type ChatMessage, sealOpenToolParts } from '@/lib/chat-messages'
import { isLiveTailRow } from '@/lib/live-tail'

const STORAGE_PREFIX = 'hermes.universal.transcriptTail.v1:'
const INDEX_KEY = 'hermes.universal.transcriptTail.v1-index'

/** Desktop's number, unchanged: "the last screen" plus scrollback. */
const TAIL_MESSAGES = 40

/** The retry tail — a conversation dominated by a few huge tool results still
 *  caches its most recent turns rather than caching nothing. */
const FALLBACK_TAIL_MESSAGES = 8

/** HALVED from desktop's 256 KiB: WebKitGTK is the tightest origin quota of the
 *  five targets, and this origin has other tenants. */
const MAX_ENTRY_BYTES = 128 * 1024

/** Matched to the crash journal's order of magnitude (24) rather than desktop's
 *  50 — a phone does not cold-open 50 different chats between launches. */
const MAX_ENTRIES = 16

/** NEW versus desktop, which bounds count only. Evicting on bytes as well as
 *  count is what makes the worst case a number instead of a hope. */
const MAX_TOTAL_BYTES = 1_536 * 1024

/** Twice the journal's 7 days: a cache of a still-existing conversation ages
 *  more gracefully than a crash journal, but a month-old tail is a worse first
 *  paint than a loader. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** One cached tail. `v` is the entry-shape version INSIDE the versioned prefix,
 *  so a shape change too small to warrant a new keyspace is still detectable. */
export interface TranscriptTailEntry {
  kind: 'tail'
  v: 1
  /** The stored session id this tail belongs to — written into the PAYLOAD as
   *  well as the key, so a keyspace scan can rebuild the index without trusting
   *  key parsing, and a mis-filed entry is detectable rather than silent. */
  storedSessionId: string
  messages: ChatMessage[]
  /** Epoch ms of the write. The LRU order and the age sweep both read this. */
  savedAt: number
  /** Serialized byte length of `messages`, recorded so the byte budget can be
   *  enforced without re-stringifying every sibling. */
  bytes: number
}

/** A lineage pointer: the pre-rotation stored id of a session that auto-compacted
 *  (MJX-133). ONE HOP ONLY — a pointer never points at a pointer. */
export interface TranscriptTailAlias {
  kind: 'alias'
  v: 1
  /** The canonical stored id whose entry holds the tail. */
  alias: string
  savedAt: number
}

export type TranscriptTailRecord = TranscriptTailAlias | TranscriptTailEntry

/** What a save actually did. Returned rather than swallowed. */
export type TailSaveResult = 'quota' | 'saved' | 'skipped-empty' | 'too-large' | 'unavailable'

export interface TranscriptTailStatus {
  available: boolean
  entries: number
  bytes: number
  lastFailure: 'corrupt' | 'quota' | 'unavailable' | null
}

interface TailIndexHint {
  v: 1
  ids: { bytes: number; id: string; savedAt: number }[]
}

// --- storage ---------------------------------------------------------------

const entryKey = (storedSessionId: string): string => `${STORAGE_PREFIX}${storedSessionId}`

let lastFailure: TranscriptTailStatus['lastFailure'] = null

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') {
      return null
    }

    return window.localStorage
  } catch {
    // A blocked-storage origin throws on ACCESS, not on use.
    lastFailure = 'unavailable'

    return null
  }
}

/** Every tail key currently in the store. The scan — not the index — is what
 *  makes an orphan reclaimable and a corrupt index harmless. */
function tailKeys(store: Storage): string[] {
  const keys: string[] = []

  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index)

    if (key?.startsWith(STORAGE_PREFIX)) {
      keys.push(key)
    }
  }

  return keys
}

/**
 * An in-memory mirror of the store's KEYS, so the common "has this session a
 * tail?" question costs no `getItem` and no parse.
 *
 * `null` means "not hydrated yet". Every window of this origin shares these
 * keys, so a `storage` event from another one drops the mirror rather than
 * letting this window trust its own stale view (the journal's MJXHRM-374 fix).
 */
let indexedIds: null | Set<string> = null

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === null || event.key.startsWith(STORAGE_PREFIX) || event.key === INDEX_KEY) {
      indexedIds = null
    }
  })
}

/** Age sweep, budget enforcement and index rebuild — ONCE per window, on the
 *  first touch rather than at import, so a module imported for its types pays
 *  nothing. */
let housekeepingDone = false

function parseRecord(raw: null | string): null | TranscriptTailRecord {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as TranscriptTailRecord

    if (parsed?.kind === 'alias') {
      return typeof parsed.alias === 'string' && parsed.alias ? parsed : null
    }

    if (parsed?.kind === 'tail') {
      return Array.isArray(parsed.messages) && typeof parsed.savedAt === 'number' && parsed.storedSessionId
        ? parsed
        : null
    }

    return null
  } catch {
    return null
  }
}

function readRecord(store: Storage, storedSessionId: string): null | TranscriptTailRecord {
  const key = entryKey(storedSessionId)
  const record = parseRecord(store.getItem(key))

  if (!record) {
    // Self-evicting: a corrupt, truncated or unrecognised entry deletes ITSELF
    // and nothing else. Separate keys are what make that possible.
    if (store.getItem(key) !== null) {
      lastFailure = 'corrupt'
      store.removeItem(key)
      indexedIds?.delete(storedSessionId)
    }

    return null
  }

  return record
}

function writeIndex(store: Storage, ids: TailIndexHint['ids']): void {
  try {
    store.setItem(INDEX_KEY, JSON.stringify({ ids, v: 1 } satisfies TailIndexHint))
  } catch {
    // An index write is a HINT write. Losing it costs an LRU ordering until the
    // next housekeeping rebuilds it from the keyspace.
  }
}

/** Rebuild the hint from the keyspace. Never deletes: an entry the index has
 *  forgotten is an orphan to reclaim, not garbage. */
function scanEntries(store: Storage): { bytes: number; id: string; key: string; savedAt: number }[] {
  const live: { bytes: number; id: string; key: string; savedAt: number }[] = []

  for (const key of tailKeys(store)) {
    const record = parseRecord(store.getItem(key))

    if (!record) {
      lastFailure = 'corrupt'
      store.removeItem(key)

      continue
    }

    const id = key.slice(STORAGE_PREFIX.length)

    live.push({
      bytes: record.kind === 'tail' ? record.bytes : 0,
      id,
      key,
      savedAt: record.savedAt
    })
  }

  return live
}

function enforceBudget(store: Storage): void {
  const live = scanEntries(store)
  const now = Date.now()

  // Newest first: the eviction rules below all take from the tail.
  live.sort((a, b) => b.savedAt - a.savedAt)

  let entries = 0
  let bytes = 0

  for (const entry of live) {
    const expired = now - entry.savedAt > MAX_AGE_MS
    const overflow = entries >= MAX_ENTRIES || bytes + entry.bytes > MAX_TOTAL_BYTES

    if (expired || overflow) {
      store.removeItem(entry.key)
      indexedIds?.delete(entry.id)

      continue
    }

    entries += 1
    bytes += entry.bytes
  }

  writeIndex(
    store,
    live
      .filter(entry => store.getItem(entry.key) !== null)
      .map(({ bytes: entryBytes, id, savedAt }) => ({ bytes: entryBytes, id, savedAt }))
  )
}

function ensureHousekeeping(): void {
  if (housekeepingDone) {
    return
  }

  housekeepingDone = true

  const store = storage()

  if (!store) {
    return
  }

  try {
    enforceBudget(store)
  } catch {
    // Best-effort, like every other write here: a failed sweep must never break
    // a launch.
  }
}

function knownIds(): Set<string> {
  ensureHousekeeping()

  if (!indexedIds) {
    const store = storage()

    // Keys only — no `getItem`, no parse. That is the whole point of the mirror.
    indexedIds = new Set(store ? tailKeys(store).map(key => key.slice(STORAGE_PREFIX.length)) : [])
  }

  return indexedIds
}

// --- the sanitiser ---------------------------------------------------------

/**
 * What may be cached, in order:
 *
 *  1. the last `limit` rows;
 *  2. NOTHING `isLiveTailRow` accepts — pending rows, `assistant-stream-*`,
 *     `inflight-assistant-*`, `user-inflight-*`, `user-queued-*`. Defence in
 *     depth: even if a cached row did reach the slice, there would be nothing in
 *     it for `preserveLocalPendingTurnMessages` to carry;
 *  3. open tool parts SEALED, so a tool call whose completion event was lost
 *     cannot render as a spinner nothing will ever resolve;
 *  4. `pending` and `reactions` dropped — the first is a live-turn flag, the
 *     second is re-fetched with the row.
 */
function sanitize(messages: ChatMessage[], limit: number): ChatMessage[] {
  const tail = messages.slice(-limit).filter(message => !isLiveTailRow(message))

  return sealOpenToolParts(tail).map(({ pending: _pending, reactions: _reactions, ...rest }) => rest)
}

// --- the public surface ----------------------------------------------------

/**
 * The cached tail for a session, or null.
 *
 * Synchronous and cheap by construction — ONE `getItem` and ONE `JSON.parse` —
 * because it is called during a first render, before any network I/O. The
 * keyspace scan is housekeeping and is deferred behind the once-per-window latch.
 *
 * Follows AT MOST ONE alias hop (a session that auto-compacted while the app was
 * closed): a second rotation misses and shows a loader, which is the honest
 * answer rather than a chain to walk.
 */
export function readTranscriptTail(storedSessionId: null | string): ChatMessage[] | null {
  if (!storedSessionId) {
    return null
  }

  const store = storage()

  if (!store) {
    return null
  }

  const record = readRecord(store, storedSessionId)
  const resolved = record?.kind === 'alias' ? readRecord(store, record.alias) : record

  // A pointer to a pointer is a mis-write, not a chain. Treat it as a miss.
  if (resolved?.kind !== 'tail' || !resolved.messages.length) {
    return null
  }

  // A mis-filed entry — the payload names a different session than the key — is
  // detectable precisely because the id is written twice.
  const expected = record?.kind === 'alias' ? record.alias : storedSessionId

  if (resolved.storedSessionId !== expected) {
    lastFailure = 'corrupt'
    store.removeItem(entryKey(expected))
    indexedIds?.delete(expected)

    return null
  }

  return resolved.messages
}

/**
 * Cache a session's tail. Returns what actually happened.
 *
 * KEYED BY THE STORED ID, never the runtime id: the runtime id is minted fresh
 * by every resume, so an entry keyed on one is unreadable the moment it matters.
 */
export function saveTranscriptTail(storedSessionId: null | string, messages: ChatMessage[]): TailSaveResult {
  if (!storedSessionId?.trim() || !messages.length) {
    return 'skipped-empty'
  }

  ensureHousekeeping()

  const store = storage()

  if (!store) {
    return 'unavailable'
  }

  const build = (limit: number): null | { entry: TranscriptTailEntry; payload: string } => {
    const kept = sanitize(messages, limit)

    if (!kept.length) {
      return null
    }

    try {
      const bytes = JSON.stringify(kept).length

      const entry: TranscriptTailEntry = {
        bytes,
        kind: 'tail',
        messages: kept,
        savedAt: Date.now(),
        storedSessionId,
        v: 1
      }

      return { entry, payload: JSON.stringify(entry) }
    } catch {
      // A non-serializable part (a circular tool result) is a skipped save, never
      // a throw on the settle path.
      return null
    }
  }

  // Never truncate a message mid-`parts`: the fallback drops whole rows.
  const built = build(TAIL_MESSAGES)
  const bounded = built && built.entry.bytes > MAX_ENTRY_BYTES ? build(FALLBACK_TAIL_MESSAGES) : built

  if (!bounded) {
    return 'skipped-empty'
  }

  if (bounded.entry.bytes > MAX_ENTRY_BYTES) {
    return 'too-large'
  }

  const write = (): boolean => {
    try {
      store.setItem(entryKey(storedSessionId), bounded.payload)

      return true
    } catch {
      return false
    }
  }

  if (!write()) {
    // "A small cache beats a stale cache" (desktop): clear the keyspace and retry
    // ONCE. A second failure is reported, never retried in a loop — a synchronous
    // stall against a full quota is worse than no paint, and typing must never be
    // affected by it.
    clearTranscriptTails()

    if (!write()) {
      lastFailure = 'quota'

      return 'quota'
    }
  }

  knownIds().add(storedSessionId)

  try {
    enforceBudget(store)
  } catch {
    /* bounded storage is best-effort; the entry above is already written */
  }

  return 'saved'
}

/**
 * Point a pre-rotation stored id at the entry that holds the tail.
 *
 * The persisted half of what `aliasStoredSessionId` does in memory: an
 * auto-compaction rotates the stored id, and the remembered-session marker, the
 * tiles and the pane ids all still name the id from before.
 */
export function aliasTranscriptTail(fromStoredId: null | string, toStoredId: null | string): void {
  if (!fromStoredId?.trim() || !toStoredId?.trim() || fromStoredId === toStoredId) {
    return
  }

  const store = storage()

  if (!store) {
    return
  }

  const alias: TranscriptTailAlias = { alias: toStoredId, kind: 'alias', savedAt: Date.now(), v: 1 }

  try {
    store.setItem(entryKey(fromStoredId), JSON.stringify(alias))
    knownIds().add(fromStoredId)
  } catch {
    /* a missing pointer costs one paint */
  }
}

/** Drop every alias of a removed conversation, in one pass. */
export function dropTranscriptTails(storedSessionIds: readonly (null | string | undefined)[]): void {
  const store = storage()

  if (!store) {
    return
  }

  for (const id of storedSessionIds) {
    if (!id) {
      continue
    }

    try {
      store.removeItem(entryKey(id))
      indexedIds?.delete(id)
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Wipe the keyspace: a gateway re-home, an explicit "use a different gateway",
 * or quota recovery.
 *
 * Another backend can recycle stored ids, so painting one machine's conversation
 * under a same-named id from another is worse than a loader (rule 20).
 */
export function clearTranscriptTails(): void {
  const store = storage()

  if (!store) {
    return
  }

  try {
    for (const key of tailKeys(store)) {
      store.removeItem(key)
    }

    store.removeItem(INDEX_KEY)
  } catch {
    /* best-effort */
  }

  indexedIds = new Set()
}

/** What the cache actually holds, and what last went wrong with it. */
export function transcriptTailCacheStatus(): TranscriptTailStatus {
  const store = storage()

  if (!store) {
    return { available: false, bytes: 0, entries: 0, lastFailure: lastFailure ?? 'unavailable' }
  }

  const live = scanEntries(store)

  return {
    available: true,
    bytes: live.reduce((total, entry) => total + entry.bytes, 0),
    entries: live.length,
    lastFailure
  }
}

/** Test seam: forget the once-per-window latch and the id mirror. */
export function __resetTranscriptTailCache(): void {
  housekeepingDone = false
  indexedIds = null
  lastFailure = null
}

export const __TAIL_CACHE_BOUNDS = {
  FALLBACK_TAIL_MESSAGES,
  MAX_AGE_MS,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  STORAGE_PREFIX,
  TAIL_MESSAGES
} as const
