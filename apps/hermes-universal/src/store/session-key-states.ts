/**
 * LEGACY — universal's SESSION-KEY session state (was `store/session-states`,
 * which is now desktop's, verbatim). It persists no tiles: desktop's module owns
 * the stored ones, and this tab list is in-memory only. Retires with the old
 * fold and the ChatScreen family (MJXHRM-602 fold steps 6–8); its importer count
 * may only shrink.
 *
 * MULTI-SESSION VIEW STATE — the write path and derivations over
 * `$sessionKeyStates`, the single map that holds EVERY session: the one on screen,
 * the ones in layout-tree tiles, and the ones behind mobile bubbles.
 *
 * The map is keyed by SESSION KEY (a runtime id once the gateway has issued one,
 * a `draft:`/`hydrating:` placeholder before that — see
 * `store/session-state-types.ts`), and `$activeSessionKey` names the slice the
 * user is looking at. `store/chat.ts`'s `$messages`/`$busy`/… are computed
 * projections of that slice, so there is no second place a transcript can live
 * and no "is this event for the chat on screen?" guard to fail open (MJX-132).
 *
 * `$sessionKeyTabs` holds the stored-session ids of open tiles; the wiring layer owns resume/submit and registers itself as
 * the delegate so tile UI stays dependency-light.
 *
 * `$workingSessionIds`/`$attentionSessionIds` live in `store/session.ts`.
 */

import { atom, computed } from 'nanostores'

import { isTileDetached } from '@/components/pane-shell/tile/detach'
import { findGroup, findGroupOfPane, type LayoutNode } from '@/components/pane-shell/tree/model'
import {
  $activeTreeGroup,
  $layoutTree,
  moveTreePane,
  noteActiveTreeGroup,
  revealTreePane
} from '@/components/pane-shell/tree/store'
import {
  DRAFT_TILE_KEY,
  DRAFT_TILE_PANE_ID,
  storedIdFromTilePane,
  TILE_PANE_PREFIX,
  WORKSPACE_PANE_ID
} from '@/lib/pane-ids'
import { discardDeltas, disposeStreamBatch, flushDeltas } from '@/lib/stream-batch'
import { requestClose } from '@/store/close-confirm'
import { clearAllCompaction } from '@/store/compaction-lifecycle'
import {
  type ClientHold,
  holdConnectionClient,
  isAmbientConnection,
  releaseConnectionClient
} from '@/store/connection-clients'
import { resetUnscopedStreamPin } from '@/store/event-router'
import { clearLiveSessionStatuses } from '@/store/live-session-registry'
import { clearAllPrompts } from '@/store/prompts'
import { $unreadFinishedSessionIds } from '@/store/session'
import {
  $activeStoredSessionId,
  applyActiveSessionStoredIdRotation,
  clearUnreadFinishedSession,
  newSession,
  sameStoredSession,
  unreadPersistenceHooks
} from '@/store/session-lifecycle'
import {
  $activeSessionKey,
  $sessionKeyStates,
  clearStoredIdIndex,
  connectionOfSessionKey,
  DEFAULT_SESSION_PROFILE,
  dropSessionState,
  emptySessionState,
  isPlaceholderKey,
  LOCAL_SESSION_SCOPE,
  publishSessionState,
  runtimeKeyForStoredSession,
  type SessionKeyState,
  type SessionRef,
  setSessionDisposeHook,
  setSessionTransitionHook,
  updateSession
} from '@/store/session-state-types'
import { sameTabRef, setTabRefResolver, tabKeyFor, tabRefFor, tabRefOf } from '@/store/tab-ref'
import { clearAllTurns } from '@/store/turn-lifecycle'
import { ownsPersistedAppState } from '@/store/windows'

export { $sessionKeyStates }

// ---------------------------------------------------------------------------
// Stall detection (presentation hint; never mutates busy).
// ---------------------------------------------------------------------------

export const $stalledSessionIds = atom<string[]>([])

// A stable identity for "no slice", so `$focusedSessionState` and the views built
// on it don't churn subscribers with a fresh object every read.
const EMPTY_SESSION_STATE: SessionKeyState = emptySessionState()

export function setSessionStalled(storedSessionId: string | null | undefined, stalled: boolean) {
  if (!storedSessionId) {
    return
  }

  const current = $stalledSessionIds.get()
  const present = current.includes(storedSessionId)

  if (stalled && !present) {
    $stalledSessionIds.set([...current, storedSessionId])
  } else if (!stalled && present) {
    $stalledSessionIds.set(current.filter(id => id !== storedSessionId))
  }
}

// --- Watchdog: marks busy sessions quiet after 8 min of stream silence -----
export const SESSION_WATCHDOG_TIMEOUT_MS = 8 * 60 * 1000
const sessionWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()

function armWatchdog(runtimeId: string) {
  const existing = sessionWatchdogTimers.get(runtimeId)

  if (existing) {
    clearTimeout(existing)
  }

  sessionWatchdogTimers.set(
    runtimeId,
    setTimeout(() => {
      sessionWatchdogTimers.delete(runtimeId)
      const current = $sessionKeyStates.get()[runtimeId]

      if (current?.busy) {
        setSessionStalled(current.storedSessionId, true)
      }
    }, SESSION_WATCHDOG_TIMEOUT_MS)
  )
}

function clearWatchdog(runtimeId: string) {
  const t = sessionWatchdogTimers.get(runtimeId)

  if (t) {
    clearTimeout(t)
    sessionWatchdogTimers.delete(runtimeId)
  }
}

// --- Transition detection (called automatically from publishSessionState) ---
function handleTransition(previous: SessionKeyState | null, next: SessionKeyState, key: string) {
  // Compression id rotation: signal the route-follow effect with enough
  // provenance that the consumer can reject it if the user navigated away.
  if (previous?.storedSessionId && next.storedSessionId && previous.storedSessionId !== next.storedSessionId) {
    if (key === $activeSessionKey.get()) {
      applyActiveSessionStoredIdRotation({
        nextStoredSessionId: next.storedSessionId,
        previousStoredSessionId: previous.storedSessionId,
        runtimeSessionId: next.runtimeSessionId ?? key
      })
    }

    setSessionStalled(previous.storedSessionId, false)
  }

  // A DRAFT taking its issued id — the guard above misses it, because a draft
  // has no previous stored id to differ from. This is the one moment the app's
  // one unsaved chat becomes a real one, so both surfaces that gave it a
  // placeholder identity trade it in here: the desktop tab record takes the id,
  // and the mobile bubble folds the id in (chat-bubbles.ts, via its own
  // `$activeStoredSessionId` watcher).
  if (!previous?.storedSessionId && next.storedSessionId) {
    adoptDraftTile({
      connectionId: next.connectionId ?? LOCAL_SESSION_SCOPE,
      profile: next.profile ?? DEFAULT_SESSION_PROFILE,
      storedSessionId: next.storedSessionId
    })
  }

  if (next.busy) {
    setSessionStalled(next.storedSessionId, false)
    armWatchdog(key)
  } else {
    clearWatchdog(key)
    setSessionStalled(next.storedSessionId, false)
    setSessionStalled(previous?.storedSessionId, false)
  }

  const storedId = next.storedSessionId

  if (!storedId) {
    return
  }

  // The busy→idle EDGE is what marks a background session unread ("your turn").
  // Gated on the FOCUSED session, not the selected one: a tile is never
  // `$activeStoredSessionId`, so keying this on the selection marked every tiled
  // chat unread the moment it finished a turn the user was watching — and
  // nothing on the tile-fronting path could clear it again.
  if (!next.busy && (previous?.busy ?? false) && !sameStoredSession(storedId, $focusedStoredSessionId.get())) {
    const cur = $unreadFinishedSessionIds.get()

    if (!cur.includes(storedId)) {
      $unreadFinishedSessionIds.set([...cur, storedId])
    }

    // And durably: the transient atom dies with the window, so without this a
    // turn that finished while you were elsewhere is forgotten by a restart.
    unreadPersistenceHooks()?.markFinished(storedId)
  }
}

// Plug the rich transition behaviour into the leaf's write path, and tear down
// per-session timers/prompts when a slice goes away.
setSessionTransitionHook(handleTransition)
setSessionDisposeHook((key, state) => {
  clearWatchdog(key)
  setSessionStalled(state.storedSessionId, false)
  clearAllPrompts(key)
  // Queued tokens for a slice that no longer exists would otherwise flush into
  // a freshly recreated one (`updateSession` creates on demand).
  discardDeltas(key)
})

export { dropSessionState, publishSessionState, runtimeKeyForStoredSession, updateSession }

/** Drop every cached session state — used on profile switch / soft gateway-mode
 *  apply, where every runtime id is dead. */
export function clearAllSessionStates() {
  for (const timer of sessionWatchdogTimers.values()) {
    clearTimeout(timer)
  }

  sessionWatchdogTimers.clear()
  clearStoredIdIndex()
  clearAllPrompts()
  // Liveness is scoped to the gateway that reported it: both callers are moving
  // to a backend whose registry we have not read yet, so every row it named is
  // as dead as the runtime ids above.
  clearLiveSessionStatuses()
  // Turns are keyed by the SAME session keys this wipes, and the map is not
  // reachable through `dropSessionState` from here — the whole atom is replaced
  // below rather than evicted key by key. Both callers (a profile switch, the
  // soft gateway switch) are moving to a backend that never issued these runtime
  // ids, so every record left behind is a turn nothing can settle, reconcile or
  // find a slice for. `clearAllTurns` and not a per-key drop, deliberately: a
  // drop settles the record, and `store/turn-hydration.ts` clears the crash
  // journal on settle — a switch must not destroy the journal a later switch
  // back would recover from.
  clearAllTurns()
  // The THIRD module keyed by session key, and the one this wipe forgot.
  // `clearAllCompaction` was written for exactly this ("profile switch, gateway
  // teardown") and had no caller at all — a compaction live at the moment of the
  // switch was left in `$compactingSessions` under a runtime id the new backend
  // will never issue, so nothing could ever clear it: the settle observer only
  // fires for turns, and `clearAllTurns` above replaces the atom wholesale
  // without emitting one. That is a permanently-set steer gate for any key that
  // came back, and a leak for every one that didn't (MJXHRM-357).
  clearAllCompaction()
  disposeStreamBatch()
  $stalledSessionIds.set([])
  $sessionKeyStates.set({})
}

/**
 * Drop the slices of the connection being LEFT that no open tab holds
 * (MJXHRM-591, invariant 37).
 *
 * A switch touches only what it leaves. `clearAllSessionStates` was the right
 * answer when the app held one socket and every runtime id died with it; with
 * tabs bound to their own backends it would wipe the transcript of every tab on
 * every OTHER connection to answer a switch none of them made — and the slices
 * of the leaving connection's own tabs, which keep streaming on its owning
 * client.
 *
 * So: only the leaving connection, and only what nothing holds. The per-key
 * teardown (`dropSessionState`) takes the timers, prompts and queued deltas with
 * each slice, exactly as an eviction does.
 */
/** Every session key an open tab depends on: its live slice, and the durable
 *  key its tail and its artifacts are filed under (which a resume does not
 *  move). What a switch may not drop. */
/** A draft tab's slice: the placeholder it was opened under, whether or not it
 *  is the one on screen. */
function draftSliceKeyOf(tile: SessionTile): null | string {
  const active = $activeSessionKey.get()

  if (isPlaceholderKey(active) && tileRuntimeKey(tile.tileKey) === active) {
    return active
  }

  return tile.runtimeId ?? null
}

export function heldSessionKeys(): Set<string> {
  const held = new Set<string>()

  for (const tile of $sessionKeyTabs.get()) {
    // EVERY record's slice key, focused or not (Design v1.3, N8): the draft
    // tile's resolver answers for the ACTIVE placeholder only, so a background
    // draft — a second tab the user started and moved away from — was not in
    // this set and a switch could drop the slice under it.
    const key = tile.tileKey === DRAFT_TILE_KEY ? draftSliceKeyOf(tile) : tileRuntimeKey(tile.tileKey)

    if (key) {
      held.add(key)
    }

    // …and the durable key its artifacts and its tail are filed under, which a
    // resume does not move.
    held.add(tileKeyFor(tileRef(tile)))
  }

  held.add($activeSessionKey.get())

  return held
}

export function dropUnheldSessionStates(leavingConnectionId: null | string): void {
  const held = heldSessionKeys()
  const leaving = leavingConnectionId ?? LOCAL_SESSION_SCOPE

  for (const [key, state] of Object.entries($sessionKeyStates.get())) {
    if (held.has(key)) {
      continue
    }

    const scope = state.connectionId ?? connectionOfSessionKey(key)

    // An UNSCOPED slice is an unbound draft (invariant 42): it belongs to no
    // connection, so no connection's departure may take it (N8).
    if (scope !== null && scope === leaving) {
      dropSessionState(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Slice lifecycle.
//
// Sessions accumulate: every chat opened from the sidebar leaves one behind, and
// each holds a full transcript. Desktop bounds this implicitly (its cache lives
// in a hook that unmounts); universal's map is module state, so it needs an
// explicit cap.
// ---------------------------------------------------------------------------

/** How many session slices to keep. Generous — the cost of an extra slice is
 *  memory, while evicting one the user comes back to costs a re-hydrate. */
export const MAX_CACHED_SESSIONS = 12

/** Keys that must never be evicted, whatever their age. */
function pinnedSessionKeys(): Set<string> {
  const pinned = new Set<string>([$activeSessionKey.get()])

  for (const tile of $sessionKeyTabs.get()) {
    const key = tileRuntimeKey(tile.storedSessionId)

    if (key) {
      pinned.add(key)
    }
  }

  return pinned
}

/**
 * Evict the least-recently-touched idle sessions once the map exceeds the cap.
 *
 * A session is only ever evicted when it is doing nothing the user would miss:
 * not on screen, not in a tile or bubble, not mid-turn, and not waiting on a
 * blocking prompt. So an over-cap map full of busy sessions simply stays over
 * cap — dropping a live turn to respect a cache bound would be the wrong trade.
 */
export function pruneSessionStates(): void {
  const states = $sessionKeyStates.get()
  const keys = Object.keys(states)

  if (keys.length <= MAX_CACHED_SESSIONS) {
    return
  }

  const pinned = pinnedSessionKeys()

  const evictable = keys
    .filter(key => {
      const state = states[key]

      return !pinned.has(key) && !state.busy && !state.awaitingResponse && !state.needsInput && !isPlaceholderKey(key)
    })
    .sort((a, b) => states[a].lastTouchedAt - states[b].lastTouchedAt)

  for (const key of evictable.slice(0, keys.length - MAX_CACHED_SESSIONS)) {
    dropSessionState(key)
  }
}

// Prune whenever the map grows. A listener rather than a call at each creation
// site, so a slice created anywhere is covered; `pruning` guards the re-entry
// caused by pruneSessionStates writing the atom it is listening to.
let pruning = false
let lastSliceCount = 0

if (ownsPersistedAppState()) {
  $sessionKeyStates.subscribe(states => {
    const count = Object.keys(states).length
    const grew = count > lastSliceCount
    lastSliceCount = count

    if (!grew || pruning) {
      return
    }

    pruning = true

    try {
      pruneSessionStates()
    } finally {
      pruning = false
    }
  })
}

/**
 * The gateway reconnected: every turn we thought was live is now unverified, and
 * the tile bindings and stream pin that named the previous socket's runs are
 * dead.
 *
 * Sessions are NOT wiped: their transcripts are still what the user was reading,
 * and a draft has no runtime binding to lose at all — clearing the map here
 * would throw away an unsent draft, which is the one thing that cannot be
 * re-fetched.
 *
 * The slice's `runtimeSessionId` is NOT cleared either, and that is the whole
 * correction (MJXHRM-358). It used to be, on the reasoning that a reconnect
 * re-issues runtime ids — but nothing ever put it back. A soft reconnect
 * re-claims the SAME live record (`_claim_or_reuse_live`), so the id is usually
 * still valid; when it genuinely is dead, `store/session-recovery.ts` rebinds it
 * on the first verb that uses it, which is exactly what that resolver exists for
 * and what tiles have always relied on. Nulling it instead made a persisted
 * conversation indistinguishable from a DRAFT for the rest of the process:
 * `ensureSession` saw no session id and answered the first message after any
 * reconnect with `session.create`, forking the chat into a brand-new empty
 * session under the old transcript. Handoff, `/branch`, the model picker, the
 * context-usage read and the compaction id-rotation guard all read the same
 * atom and went dead with it.
 *
 * What IS cleared is the liveness: `busy` and `turnStartedAt` describe a turn on
 * a socket that no longer exists. `store/turn-lifecycle.ts#reconcileInflightTurns`
 * re-arms them for a turn the gateway is still running, and `session.active_list`
 * (store/live-session-status.ts) covers the sessions that had no local record.
 */
export function invalidateRuntimeBindings(): void {
  resetUnscopedStreamPin()
  flushDeltas()
  resetTileRuntimeBindings()

  for (const [key, state] of Object.entries($sessionKeyStates.get())) {
    if (state.busy || state.turnStartedAt !== null) {
      updateSession(key, current => ({ ...current, busy: false, turnStartedAt: null }))
    }
  }
}

// ---------------------------------------------------------------------------
// Session tiles.
// ---------------------------------------------------------------------------

export type SplitDir = 'bottom' | 'left' | 'right' | 'top'
export type TileDock = 'center' | SplitDir

/**
 * An open tab.
 *
 * The REF — connection, profile, stored id, and the backend identity it bound to
 * — is `readonly`, and is the tab's whole address (MJXHRM-591, invariant 38). A
 * tab is self-contained: no tab path asks which connection is active, and no
 * path can repoint one. Backends mint `uuid4().hex[:8]`, per state.db, so the
 * same stored id turning up on two of them is expected rather than meaningful —
 * a tab whose backend changed under it goes UNAVAILABLE and offers Close, since
 * rebinding would show another machine's chat under this tab's history.
 *
 * `tileKey` is the tab's identity: its ref, encoded by `storedKeyFor`. Pane ids,
 * the closed-tab stack and every verb below address a tab by it — and for the
 * local connection's default profile it IS the bare stored id, so a
 * single-source install's pane ids and storage stay byte-identical.
 */
export interface SessionTile {
  readonly tileKey: string
  readonly connectionId: string
  readonly profile: string
  readonly storedSessionId: string
  /** The backend this tab bound to (`TunnelDescriptor.instanceKey`), learned at
   *  its first resume. A different one later is a different machine. */
  readonly backendIdentity?: string
  /** The tab's name, as last seen in a session row (invariant 43).
   *
   *  A tab's title resolves through the sidebar's rows, and those are the ACTIVE
   *  backend's: a switch empties them, so a tab bound to any other connection
   *  would fall back to rendering its id. The snapshot is refreshed whenever
   *  that tab's own row is in front of us. */
  title?: string
  dir?: TileDock
  anchor?: string
  before?: null | string
  runtimeId?: string
  error?: string
  /** The tab's backend changed under it: it routes nothing, resumes nothing and
   *  offers exactly one verb (`tileActions`). */
  unavailable?: boolean
}

/** The identity of the tab for `ref`. */
// The ref, the key and the resolver are `store/tab-ref`'s — ONE set of rules for
// the desktop's tabs and the phone's bubbles (invariant 44). The tile layer
// keeps its own names for them, so the rest of the app reads as it always did.
export const tileKeyFor = tabKeyFor
export const tileRef = tabRefOf
const sameRef = sameTabRef

/**
 * Is this tab the same CONVERSATION as `ref` — on the same backend?
 *
 * "Already open?" is asked by conversation, not by string, because auto-
 * compression rotates a stored id and the tab keeps the one it opened with
 * (MJX-133). It is now also asked WITHIN one connection and profile: the same
 * `uuid4().hex[:8]` on two backends is two chats, and matching across them
 * would front a tab onto another machine's session.
 */
const sameTileConversation = (tile: SessionTile, ref: SessionRef): boolean =>
  tile.connectionId === ref.connectionId &&
  tile.profile === ref.profile &&
  sameStoredSession(tile.storedSessionId, ref.storedSessionId)

/**
 * Where a bare stored id's tab belongs.
 *
 * Every tab records its FULL ref when it opens, and a caller holding a row (a
 * sidebar entry, a waiting prompt, a deep link) knows which connection that row
 * came from — `store/session-sources` tags every merged row with its owner.
 * This is that lookup, INJECTED rather than imported so the tile layer stays
 * dependency-light, and resolved ONCE, at open: nothing re-reads it afterwards,
 * which is what makes the tab self-contained rather than "usually right".
 */
export const setSessionRefResolver = setTabRefResolver
const sessionRefFor = tabRefFor

// In memory only: desktop's `store/session-states` owns the persisted tiles, and
// a second writer on that storage would corrupt it.
export const $sessionKeyTabs = atom<SessionTile[]>([])

/**
 * THE write path for the tab list.
 *
 * Exported because it is also the guard: every list write goes through it, so a
 * caller that assembles a list — a merge, a restore, a reorder — cannot smuggle
 * a repointed tab past the type system by rebuilding the record.
 */
/**
 * THE HOLD LEDGER (MJXHRM-591, invariant 47).
 *
 * A hold belongs to the tab RECORD, not to a network path: this map is written
 * by the commit below and by nothing else, so "how many tabs want this
 * connection" is the set of tab records, counted where that set changes. A
 * rebind is no change in presence and cannot double-count; a failed resume
 * cannot leak, because it never took one; and an UNAVAILABLE tab gives its hold
 * back, because it will never use that connection again.
 */
const holdsByTab = new Map<string, ClientHold>()

/** Which records are entitled to a hold: present, and still usable. */
const heldTabs = (tiles: readonly SessionTile[]): Map<string, SessionTile> =>
  new Map(tiles.filter(tile => !tile.unavailable && tile.tileKey !== DRAFT_TILE_KEY).map(tile => [tile.tileKey, tile]))

function commitTabHolds(next: readonly SessionTile[]): void {
  const wanted = heldTabs(next)

  for (const [tabKey, tile] of wanted) {
    if (!holdsByTab.has(tabKey)) {
      const hold = holdConnectionClient(tile.connectionId, { ambient: isAmbientConnection(tile.connectionId) })

      if (hold) {
        holdsByTab.set(tabKey, hold)
      }
    }
  }

  for (const [tabKey, hold] of [...holdsByTab]) {
    if (!wanted.has(tabKey)) {
      holdsByTab.delete(tabKey)
      releaseConnectionClient(hold)
    }
  }
}

export function saveSessionTiles(tiles: SessionTile[]) {
  // A write may not repoint a tab. `patchSessionTile` makes a repoint impossible
  // to COMPILE; this catches one assembled dynamically — a merged list, a
  // restored blob — and keeps the live tab rather than adopting the stranger.
  const live = new Map($sessionKeyTabs.get().map(tile => [tile.tileKey, tile]))

  const guarded = tiles.map(tile => {
    const current = live.get(tile.tileKey)

    if (current && !sameRef(current, tile)) {
      console.warn('[tiles] refused a write that would repoint a bound tab', { tileKey: tile.tileKey })

      return current
    }

    return tile
  })

  $sessionKeyTabs.set(guarded)
  // …and the holds follow the records, in the same commit.
  commitTabHolds(guarded)
}

// A connection or profile switch changes NOTHING here (invariant 37): a tab
// carries its own connection and keeps its slice, its client and its place. The
// v2 code swapped the visible set per profile and called `clearAllSessionStates`
// — with tabs bound to their own backends, that would wipe the transcripts of
// every tab on every OTHER connection to answer a switch none of them made.

/** The live session key behind a tab, following a compaction id rotation. Takes
 *  the tab's KEY, so two connections' identical stored ids resolve to their own
 *  slices rather than to whichever was indexed last (MJXHRM-591). */
export function tileRuntimeKey(tileKey: null | string): null | string {
  if (!tileKey) {
    return null
  }

  // The draft tile names no session, so there is no stored id to look up — its
  // slice is the active placeholder one. Resolving it HERE rather than in the
  // pane is what makes the draft a tile like any other: its view, its busy
  // state and its close-confirm all read through this one function.
  if (tileKey === DRAFT_TILE_KEY) {
    const active = $activeSessionKey.get()

    return isPlaceholderKey(active) ? active : null
  }

  const tile = $sessionKeyTabs.get().find(t => t.tileKey === tileKey)

  return runtimeKeyForStoredSession(tile?.storedSessionId ?? tileKey, tile && tileRef(tile)) ?? tile?.runtimeId ?? null
}

/**
 * Everything about a tab EXCEPT where it points.
 *
 * The ref fields are absent from the patch type, so a repoint does not compile —
 * the same shape as 592's `&self` pin on the tunnel verdict. A tab that can be
 * repointed is a tab that can show another machine's chat under this one's
 * history, and no UI verb, recovery path or migration is allowed to do it
 * (invariant 38).
 */
export type SessionTilePatch = Partial<
  Omit<SessionTile, 'backendIdentity' | 'connectionId' | 'profile' | 'storedSessionId' | 'tileKey'>
>

export function patchSessionTile(tileKey: string, patch: SessionTilePatch) {
  saveSessionTiles($sessionKeyTabs.get().map(t => (t.tileKey === tileKey ? { ...t, ...patch } : t)))
}

/**
 * Keep each tab's title snapshot in step with the rows in front of us
 * (invariant 43).
 *
 * Called with rows that carry their own connection, so a tab is only ever named
 * by ITS backend's row — the same stored id on another one is another
 * conversation, and taking its title would put a stranger's name on this tab.
 */
export function refreshTileTitles(
  rows: readonly { connection_id?: null | string; id: string; title?: null | string }[]
): void {
  const byKey = new Map<string, string>()

  for (const row of rows) {
    const title = (row.title ?? '').trim()

    if (title) {
      byKey.set(`${row.connection_id || LOCAL_SESSION_SCOPE}\u0000${row.id}`, title)
    }
  }

  if (byKey.size === 0) {
    return
  }

  let changed = false

  const next = $sessionKeyTabs.get().map(tile => {
    const title = byKey.get(`${tile.connectionId}\u0000${tile.storedSessionId}`)

    if (!title || title === tile.title) {
      return tile
    }

    changed = true

    return { ...tile, title }
  })

  if (changed) {
    saveSessionTiles(next)
  }
}

/**
 * Learn the backend a tab bound to — or find out it changed under it
 * (MJXHRM-591, invariant 38).
 *
 * The identity is `TunnelDescriptor.instanceKey`: the machine and the install,
 * not the session. The FIRST one a tab sees is its binding, and is written once
 * (which is why `backendIdentity` is absent from `SessionTilePatch` — nothing
 * else may set it). A DIFFERENT one later is a different backend: the tab goes
 * UNAVAILABLE, keeping its ref, because a shared stored id across two backends
 * is expected rather than meaningful and adopting it would show another
 * machine's chat under this tab's history.
 *
 * Returns whether the tab may still be used.
 */
export function noteTileBackendIdentity(tileKey: string, instanceKey: null | string | undefined): boolean {
  const key = (instanceKey ?? '').trim()
  const tiles = $sessionKeyTabs.get()
  const tile = tiles.find(open => open.tileKey === tileKey)

  if (!tile || !key) {
    return !tile?.unavailable
  }

  if (!tile.backendIdentity) {
    saveSessionTiles(tiles.map(open => (open.tileKey === tileKey ? { ...open, backendIdentity: key } : open)))

    return true
  }

  if (tile.backendIdentity === key) {
    return !tile.unavailable
  }

  saveSessionTiles(tiles.map(open => (open.tileKey === tileKey ? { ...open, unavailable: true } : open)))

  return false
}

/** What an UNAVAILABLE tab offers: exactly one verb. Its backend changed under
 *  it, so there is nothing to resume, retry or reopen — only to close. */
export const UNAVAILABLE_TILE_ACTIONS: readonly ['close'] = ['close']

/** The verbs a tab offers. Anything but `close` requires a tab still bound to
 *  the backend it was opened against. */
export function tileActions(tile: SessionTile): readonly string[] {
  return tile.unavailable ? UNAVAILABLE_TILE_ACTIONS : ['close', 'retry', 'branch', 'archive', 'delete']
}

/** Drop live runtime bindings so every tile re-resumes — used on gateway reconnect. */
export function resetTileRuntimeBindings() {
  const tiles = $sessionKeyTabs.get()

  if (tiles.some(t => t.runtimeId)) {
    $sessionKeyTabs.set(tiles.map(({ runtimeId: _runtimeId, ...tile }) => tile))
  }
}

// ---------------------------------------------------------------------------
// Delegate — the wiring layer (owns the gateway + session cache) plugs in.
// ---------------------------------------------------------------------------

export interface SessionTileDelegate {
  archiveSession(storedSessionId: string): Promise<void>
  branchSession(storedSessionId: string): Promise<void>
  deleteSession(storedSessionId: string): Promise<void>
  interruptSession(runtimeId: string): Promise<void>
  resumeTile(storedSessionId: string): Promise<string>
  submitToSession(runtimeId: string, text: string, displayText?: string): Promise<void>
  updateSession(runtimeId: string, updater: (state: SessionKeyState) => SessionKeyState): SessionKeyState
}

let delegate: SessionTileDelegate | null = null

export function setSessionTileDelegate(next: SessionTileDelegate) {
  delegate = next
}

export function sessionTileDelegate(): SessionTileDelegate | null {
  return delegate
}

/** Reorder tiles to match layout-tree encounter order. Returns `null` when
 *  nothing moves so callers can skip a needless persist. */
export function orderTilesByTree<T extends { tileKey: string }>(
  tree: LayoutNode | null,
  tiles: readonly T[]
): null | T[] {
  if (!tree || tiles.length < 2) {
    return null
  }

  const order: string[] = []

  const walk = (node: LayoutNode) => {
    if (node.type === 'group') {
      for (const id of node.panes) {
        if (id.startsWith(TILE_PANE_PREFIX)) {
          order.push(id.slice(TILE_PANE_PREFIX.length))
        }
      }

      return
    }

    node.children.forEach(walk)
  }

  walk(tree)

  const rank = new Map(order.map((id, i) => [id, i]))

  const next = [...tiles].sort((a, b) => (rank.get(a.tileKey) ?? Infinity) - (rank.get(b.tileKey) ?? Infinity))

  return next.some((t, i) => t !== tiles[i]) ? next : null
}

/**
 * Keep the PERSISTED tile order in step with the order on screen.
 *
 * The layout tree owns where a tab sits; `$sessionKeyTabs` is a parallel list that
 * outlives it, and two consumers read that list's ORDER rather than the tree's:
 *
 *  - `stackSessionTilesIntoMain` — the layout-RESET handler
 *    (`registerLayoutResetHandler`, app/contrib/controller.tsx) — restacks every
 *    tile into the workspace zone by walking `$sessionKeyTabs` front to back;
 *  - `paneMirror` re-registers panes in array order, which is the order they
 *    dock in when the tree holds no pane for them yet (a profile switch back, or
 *    a tree that lost them).
 *
 * So a stale list is not cosmetic: drag three tabs into the order you want, hit
 * Reset, and they come back in the order they were OPENED in.
 *
 * This ran from exactly one caller — `openSessionTile`'s move branch — and every
 * OTHER way the on-screen order changes left the list behind: dragging a tab
 * within a strip (`reorderTreePanes`), dragging one between zones
 * (`moveTreePanes`), the zone menu's Move (`moveTreePane`), a shift-drag zone
 * merge, and a preset application that re-homes panes. Hanging it off the tree
 * itself covers all of them at once, including any future writer — the invariant
 * belongs to the tree changing, not to the handful of callers that happened to
 * be written first.
 *
 * Safe to run on every commit. `orderTilesByTree` returns `null` unless the
 * order actually moved, so the common case costs one walk and no write; and a
 * pure reorder of `$sessionKeyTabs` registers and removes nothing in `paneMirror`
 * (it diffs by key, then by title/accent), so this cannot drive the tree write
 * that would re-enter it.
 */
function syncTileStripOrder() {
  const next = orderTilesByTree($layoutTree.get(), $sessionKeyTabs.get())

  if (next) {
    saveSessionTiles(next)
  }
}

// `listen`, not `subscribe`: the initial tree is mirrored into tiles by the
// registrations that FOLLOW it, and firing before any pane exists would only
// rank every tile `Infinity`.
$layoutTree.listen(syncTileStripOrder)

/**
 * Open a tile for a stored session, or MOVE an existing one to the new dock. The
 * session LOADED IN MAIN never opens as a tile.
 *
 * Both "is this already in main" and "is this already a tile" are asked by
 * CONVERSATION, not by string. A tile keeps the id it was opened with while
 * auto-compression rotates the session's live id, so the sidebar row for a
 * compacted chat and the tile already showing it carry different ids — and
 * matching on identity opened a second tab onto the same live slice, which then
 * fought the first for its pane title and its close verb (MJXHRM-423).
 *
 * The existing tile's OWN key is what gets moved: its pane id and its
 * `$sessionKeyTabs` record are both keyed on it, and re-keying a live tile to the
 * new id would strand the pane the layout tree already holds.
 */
export function openSessionTile(
  storedSessionId: string,
  dir: TileDock = 'right',
  anchor?: string,
  before?: null | string
) {
  const tiles = $sessionKeyTabs.get()

  if (sameStoredSession(storedSessionId, $activeStoredSessionId.get())) {
    return
  }

  const ref = sessionRefFor(storedSessionId)
  const open = tiles.find(tile => sameTileConversation(tile, ref))

  if (!open) {
    // The FULL ref, resolved once, here: from this point the tab addresses its
    // own connection and nothing re-asks which one is active (invariant 29).
    saveSessionTiles([...tiles, { ...ref, anchor, before, dir, tileKey: tileKeyFor(ref) }])

    return
  }

  const tree = $layoutTree.get()
  const target = tree ? findGroupOfPane(tree, anchor ?? WORKSPACE_PANE_ID)?.id : null

  if (target) {
    // No explicit re-order here: `moveTreePane` commits the tree, and the tree
    // is what `syncTileStripOrder` now listens to. `patchSessionTile` maps the
    // list in place, so it cannot disturb the order that landed first.
    moveTreePane(`${TILE_PANE_PREFIX}${open.tileKey}`, { before: before ?? null, groupId: target, pos: dir })
    patchSessionTile(open.tileKey, { anchor, before: before ?? undefined, dir })
  }
}

/**
 * Where a BRANCH lands: its own tab in the strip its PARENT is in, fronted.
 *
 * Both halves are load-bearing, and neither came for free:
 *
 *  - the ANCHOR. `openSessionTile` with none docks against the workspace, so a
 *    branch of a chat that is itself a tile in a side zone appeared in the main
 *    strip — a tab in a zone the user was not looking at. `newSessionTab`
 *    already anchors ⌘T "in the strip you asked from"; a branch is the same act
 *    with a seeded transcript.
 *  - the FOCUS. Registering a tile only CONTRIBUTES a pane, and adoption is
 *    deliberately silent (`insertAtGroup(..., activate: false)` — a tool panel
 *    must not steal its zone's tab on boot), so the branch was stacked into the
 *    strip BEHIND the chat it came from and nothing on screen changed. That is
 *    the "never foregrounds the new tab" this ticket is named for, and it
 *    outlived PR #125, which only stopped the branch claiming the main pane.
 *    `focusOpenSession` is the explicit reveal every other on-screen jump uses.
 */
export function openBranchTile(branchStoredId: string, parentStoredId: null | string): void {
  const anchor =
    parentStoredId && $sessionKeyTabs.get().some(t => t.tileKey === tileKeyFor(sessionRefFor(parentStoredId)))
      ? `${TILE_PANE_PREFIX}${tileKeyFor(sessionRefFor(parentStoredId))}`
      : WORKSPACE_PANE_ID

  openSessionTile(branchStoredId, 'center', anchor)
  focusOpenSession(branchStoredId)
}

/**
 * Open a session as its OWN tab in the main strip, beside whatever is there —
 * never by taking over the main chat.
 *
 * Already on screen (a tile, or the chat loaded in main) → it is only fronted:
 * `openSessionTile` would MOVE an existing tile out of the zone the user put it
 * in. Otherwise the tab is added and, unless `focus` is false, fronted —
 * registering a tile only contributes a pane (see `openBranchTile`), so without
 * the explicit reveal it would stack behind the chat the user was reading. The
 * tile resumes itself on mount, and binds straight to a slice already warm.
 */
export function openSessionTab(storedSessionId: string, focus = true): void {
  const ref = sessionRefFor(storedSessionId)

  const onScreen =
    sameStoredSession(storedSessionId, $activeStoredSessionId.get()) ||
    $sessionKeyTabs.get().some(tile => sameTileConversation(tile, ref))

  if (!onScreen) {
    openSessionTile(storedSessionId, 'center', WORKSPACE_PANE_ID)
  }

  if (focus) {
    focusOpenSession(storedSessionId)
  }
}

/**
 * "New chat tab" — ⌘T, and the `+` at the end of a chat tab strip.
 *
 * The new chat gets its OWN tile, beside whatever is already open. It used to
 * work the other way around: the draft took over the main pane and the chat that
 * was already there got parked into a tile — so asking for a new chat moved a
 * chat you had not asked about, and the new one was the single chat in the app
 * that was not a tile. A draft is a session like any other in `$sessionKeyStates`;
 * this makes it a tile like any other too.
 *
 * ONE draft at a time: a second `+` on an empty draft fronts the one already
 * there rather than stacking up empty chats nobody sent a message in.
 *
 * Takes no directory: `resetChat` resolves the sidebar's project scope for every
 * fresh draft (MJXHRM-393), so ⌘T inherits it without this having to be told.
 */
export function newSessionTab(): void {
  newSession()

  // Anchored on the chat the user is looking at, stacked into its zone — a new
  // tab belongs in the strip you asked from, not docked to the side.
  const anchor = activeChatPaneId()

  if (!$sessionKeyTabs.get().some(t => t.tileKey === DRAFT_TILE_KEY)) {
    // The one UNBOUND tab (invariant 42): it holds no ref, so it renders and
    // routes against the active connection and re-points on every switch, until
    // its first `session.create` dispatch binds it once and for good.
    saveSessionTiles([
      ...$sessionKeyTabs.get(),
      {
        anchor,
        connectionId: LOCAL_SESSION_SCOPE,
        dir: 'center',
        profile: DEFAULT_SESSION_PROFILE,
        storedSessionId: DRAFT_TILE_KEY,
        tileKey: DRAFT_TILE_KEY
      }
    ])
  }

  focusDraftTile(anchor)
}

/**
 * Front the draft tile and claim the zone it lives in.
 *
 * The zone is resolved from the ANCHOR, not from the draft's own pane: the tile
 * was registered a moment ago and the pane mirror does not put it in the tree
 * until React's next commit, so looking the draft up here finds nothing and the
 * focused zone stays `null` — which is exactly the state that leaves ⌥1-9 and
 * ⌃Tab inert (they read `$activeTreeGroup` raw). The draft stacks INTO the
 * anchor's zone, so the anchor names the right group and it is already there.
 */
function focusDraftTile(anchor: string): void {
  revealTreePane(DRAFT_TILE_PANE_ID)

  const tree = $layoutTree.get()

  if (!tree) {
    return
  }

  const group = findGroupOfPane(tree, DRAFT_TILE_PANE_ID) ?? findGroupOfPane(tree, anchor)

  if (group) {
    noteActiveTreeGroup(group.id)
  }
}

/** The pane of the chat currently on screen — a tile's if one is fronted, else
 *  the workspace. What a new tab anchors to. */
function activeChatPaneId(): string {
  const active = $activeStoredSessionId.get()
  const key = active ? tileKeyFor(sessionRefFor(active)) : null
  const tile = key && $sessionKeyTabs.get().some(t => t.tileKey === key)

  return tile ? `${TILE_PANE_PREFIX}${key}` : WORKSPACE_PANE_ID
}

/**
 * The draft tile taking its real session id, on first submit.
 *
 * Carries the tile RECORD only. It used to rename the draft's tree pane in place
 * too, but these tabs own no tree panes any more — `app/chat/session-tile`
 * registers panes from desktop's `$sessionTiles`, whose tiles are created with
 * their stored id — and desktop's tree store has no rename to call.
 */
function adoptDraftTile(ref: SessionRef): void {
  const tiles = $sessionKeyTabs.get()

  if (!tiles.some(t => t.tileKey === DRAFT_TILE_KEY)) {
    return
  }

  const tileKey = tileKeyFor(ref)

  // Already open as its own tile (the draft was abandoned onto an existing
  // chat): drop the draft rather than creating a duplicate tab for one session.
  if (tiles.some(t => t.tileKey === tileKey)) {
    saveSessionTiles(tiles.filter(t => t.tileKey !== DRAFT_TILE_KEY))

    return
  }

  // THE BINDING MOMENT, and the only one (invariant 42). The ref comes from the
  // slice, which took it synchronously at its `session.create` dispatch — not
  // from `$activeConnection`, which a switch during the round trip would have
  // moved. From here the tab is an ordinary bound tab: irreversible, and
  // Close-only if its backend ever changes.
  saveSessionTiles(tiles.map(t => (t.tileKey === DRAFT_TILE_KEY ? { ...t, ...ref, tileKey } : t)))
}

/**
 * Front the MAIN chat and make its zone the focused one.
 *
 * The workspace half of `focusOpenSession`, extracted because a NEW session
 * needs exactly this and the two must not drift (MJXHRM-6).
 *
 * It names the workspace's real group rather than `null` on purpose. The passive
 * `$activeStoredSessionId` listener below homes to `null`, which leaves
 * `activateTreeTabSlot` / `cycleTreeTabInFocusedZone` inert — they read
 * `$activeTreeGroup` raw, with none of `closeFocusedTabInZone`'s main-pane
 * fallback — so ⌥1-9 and ⌃Tab could not switch between two tabs the user was
 * looking at. An explicit focus act claims the zone; passive navigation does not.
 */
export function focusWorkspaceSession(): void {
  revealTreePane(WORKSPACE_PANE_ID)

  const tree = $layoutTree.get()

  noteActiveTreeGroup(tree ? (findGroupOfPane(tree, WORKSPACE_PANE_ID)?.id ?? null) : null)
}

/** If a session is already ON SCREEN — an open tile OR the one loaded in main —
 *  front its tab (and focus its zone) and return true; `false` = the caller must
 *  load it into main. */
export function focusOpenSession(storedSessionId: string, ref?: SessionRef): boolean {
  const tileKey = tileKeyFor(ref ?? sessionRefFor(storedSessionId))

  if ($sessionKeyTabs.get().some(t => t.tileKey === tileKey)) {
    const paneId = `${TILE_PANE_PREFIX}${tileKey}`
    revealTreePane(paneId)
    const tree = $layoutTree.get()
    const group = tree ? findGroupOfPane(tree, paneId) : null

    if (group) {
      noteActiveTreeGroup(group.id)
    }

    return true
  }

  if (storedSessionId === $activeStoredSessionId.get()) {
    focusWorkspaceSession()

    return true
  }

  return false
}

// Closed-tab stack for ⌘⇧T reopen (in-memory). One stack, not one per profile:
// a closed tab carries its own connection and profile, so reopening it restores
// the tab that was closed rather than "the one with that id on whatever the app
// is pointed at now".
const closedTiles: SessionTile[] = []
const closedStack = (): SessionTile[] => closedTiles

export function closeSessionTile(tileKey: string) {
  const tile = $sessionKeyTabs.get().find(t => t.tileKey === tileKey)

  // The draft is not reopenable: ⌘⇧T would restore a tab for a chat that never
  // existed. Closing an empty draft discards it, which is what closing an empty
  // draft means.
  if (tile && tile.tileKey !== DRAFT_TILE_KEY) {
    closedStack().push({
      ...tileRef(tile),
      anchor: tile.anchor,
      before: tile.before,
      dir: tile.dir,
      tileKey: tile.tileKey
    })
  }

  saveSessionTiles($sessionKeyTabs.get().filter(t => t.tileKey !== tileKey))
}

/**
 * Would closing this SLICE drop work in flight — a running turn, a reply on the
 * way, or a prompt waiting on the user?
 *
 * Exported because a session is closeable from two unrelated surfaces (a
 * layout-tree TILE and a mobile BUBBLE) and only one of them used to ask. The
 * predicate is the thing they have to share; what they do with the answer goes
 * through `requestClose` (store/close-confirm). It takes a runtime KEY rather
 * than a stored id because the two surfaces resolve that key differently — a
 * tile through `tileRuntimeKey`, a bubble through `bubbleRuntimeKey` — and
 * forcing one resolver on both is how a bubble would end up reading the wrong
 * session's busy flag.
 */
export function sessionKeyNeedsCloseConfirm(runtimeKey: null | string): boolean {
  const state = runtimeKey ? $sessionKeyStates.get()[runtimeKey] : undefined

  return Boolean(state?.busy || state?.awaitingResponse || state?.needsInput)
}

/** Close a tile — but confirm first if its session is still working / waiting.
 *  The key is resolved through the reverse index rather than the tile's cached
 *  runtimeId, so a session whose stored id rotated under a background compaction
 *  is still recognised as busy instead of closing without a prompt (MJX-133). */
export function requestCloseSessionTile(tileKey: string): void {
  requestClose(
    { close: () => closeSessionTile(tileKey), id: tileKey, kind: 'session' },
    sessionKeyNeedsCloseConfirm(tileRuntimeKey(tileKey))
  )
}

/** Drop a DEAD tile — a persisted tile whose session no longer exists (resume
 *  404s). Leaves no ⌘⇧T undo and evicts any cached state. */
export function discardSessionTile(tileKey: string) {
  const key = tileRuntimeKey(tileKey)

  if (key) {
    dropSessionState(key)
  }

  saveSessionTiles($sessionKeyTabs.get().filter(t => t.tileKey !== tileKey))
}

/** ⌘⇧T — reopen the most recently closed tab where it was, then FOCUS it.
 *  Adoption alone is silent (it must not steal the active tab), so restore has
 *  to front the pane explicitly or the tab comes back behind whatever you were
 *  looking at. Skips conversations that are live again — reopened, or now the
 *  primary — asked by CONVERSATION rather than by id, because the stack holds
 *  the key the tile had when it CLOSED and a compaction since then has moved the
 *  session on (MJXHRM-423). */
export function reopenLastClosedTile(): void {
  const stack = closedStack()

  for (let tile = stack.pop(); tile; tile = stack.pop()) {
    const { storedSessionId } = tile

    if (sameStoredSession(storedSessionId, $activeStoredSessionId.get())) {
      continue
    }

    if (!$sessionKeyTabs.get().some(t => sameTileConversation(t, tileRef(tile)))) {
      openSessionTile(storedSessionId, tile.dir, tile.anchor, tile.before)
      focusOpenSession(storedSessionId, tileRef(tile))

      return
    }
  }
}

/** The open tab that is still an empty "New session" draft, if there is one.
 *  That tab is the one the user would have typed into, so an open-from-nowhere
 *  SPENDS it instead of stacking a second blank tab beside it. Most recent
 *  wins; a tile whose runtime hasn't bound (or whose state hasn't published) is
 *  unknown rather than empty, so it is left alone. */
export function blankDraftTile(
  tiles: readonly SessionTile[],
  states: Record<string, SessionKeyState>
): null | SessionTile {
  // Reverse scan rather than `findLast` — this project's lib target predates it.
  for (let i = tiles.length - 1; i >= 0; i--) {
    const key = tileRuntimeKey(tiles[i].tileKey)
    const state = key ? states[key] : undefined

    if (state && !state.busy && state.messages.length === 0) {
      return tiles[i]
    }
  }

  return null
}

/** Hand an open blank draft tab over to `storedSessionId`, keeping its slot.
 *  False when there is no such tab, so the caller can fall back. The spent
 *  draft is DISCARDED rather than closed: it never held a conversation, so ⌘⇧T
 *  resurrecting it would just restore an empty tab. */
export function reuseBlankDraftTile(storedSessionId: string): boolean {
  const tile = blankDraftTile($sessionKeyTabs.get(), $sessionKeyStates.get())

  if (!tile || tile.storedSessionId === storedSessionId) {
    return false
  }

  discardSessionTile(tile.tileKey)
  openSessionTile(storedSessionId, tile.dir, tile.anchor, tile.before)
  revealTreePane(`${TILE_PANE_PREFIX}${tileKeyFor(sessionRefFor(storedSessionId))}`)

  return true
}

/**
 * The session tile that should shift INTO main when the workspace tab closes:
 * the nearest chat tab in main's own strip, scanning right first and then left
 * (the tab that fills the slot, then its neighbour). Null when main is the only
 * chat in its zone — the caller then drops main to a fresh draft.
 *
 * Scoped to main's OWN group, which is what keeps floating placements out of it:
 * a floating pane is rendered outside the tree's tab strips and is never in this
 * group. DETACHED tiles need an explicit skip instead — detach deliberately KEEPS
 * the tile's slot in the tree (that is what makes reattach well-defined), so a
 * detached chat is a tab here while another native window is the thing actually
 * showing it. Promoting one would close it out from under that window.
 */
export function nextSessionTileForWorkspace(): null | string {
  const tree = $layoutTree.get()
  const group = tree ? findGroupOfPane(tree, WORKSPACE_PANE_ID) : null

  if (!group) {
    return null
  }

  const tiles = $sessionKeyTabs.get()
  const idx = group.panes.indexOf(WORKSPACE_PANE_ID)
  // After the workspace tab first, then the ones before it (nearest-out).
  const ordered = [...group.panes.slice(idx + 1), ...group.panes.slice(0, idx).reverse()]

  for (const paneId of ordered) {
    const storedSessionId = storedIdFromTilePane(paneId)

    if (isTileDetached(paneId)) {
      continue
    }

    if (storedSessionId && tiles.some(t => t.tileKey === storedSessionId)) {
      return storedSessionId
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// The FOCUSED session — one derivation. The layout's interaction tracker
// ($activeTreeGroup) resolves to a zone; its active pane names the session: a
// `session-tile:<storedId>` pane IS that session, anything else falls back to the
// route-driven active session.
// ---------------------------------------------------------------------------

/**
 * The last interacted zone that actually HOSTS a chat.
 *
 * `$activeTreeGroup` moves on every pointerdown/focusin anywhere in the tree, so
 * clicking a folder in the file tree — or the terminal, or the review pane —
 * makes a non-chat zone the interacted one, and the derivation below would fall
 * straight back to the sidebar's selection. Everything keyed on "the focused
 * session" would then bounce between the tile you were reading and whatever the
 * sidebar last picked, every time you touched a side pane.
 *
 * Zones hosting the workspace count: the main pane's session IS the selection,
 * so falling back there is the right answer rather than a stale one.
 */
const $chatTreeGroup = atom<null | string>(null)

$activeTreeGroup.subscribe(groupId => {
  const tree = $layoutTree.get()
  const active = groupId && tree ? findGroup(tree, groupId)?.active : undefined

  if (active === WORKSPACE_PANE_ID || active?.startsWith(TILE_PANE_PREFIX)) {
    $chatTreeGroup.set(groupId)
  }
})

/** Pane id of the FOCUSED chat surface — the interacted chat zone's tile, else
 *  the workspace. The composer focus bus resolves `'active'` through this, so
 *  typing lands in the chat you are looking at rather than the one that mounted
 *  last. */
export const $focusedChatPane = computed([$chatTreeGroup, $layoutTree], (groupId, tree) => {
  const active = groupId && tree ? findGroup(tree, groupId)?.active : undefined

  return active?.startsWith(TILE_PANE_PREFIX) ? active : WORKSPACE_PANE_ID
})

/** Stored id of the focused session (the interacted chat zone's tile, else the active one). */
export const $focusedStoredSessionId = computed(
  [$focusedChatPane, $activeStoredSessionId],
  (pane, selected) => storedIdFromTilePane(pane) ?? selected
)

// Looking at a session is what makes it read — and on a multi-tile shell that
// is the FOCUSED chat, not the selected one. `$activeStoredSessionId` has its
// own listener in store/session (a primary navigation), which covers the case
// where a tile keeps focus while the workspace switches sessions; this covers
// the one that listener cannot see: fronting an already-open tile.
$focusedStoredSessionId.listen(storedId => {
  if (storedId) {
    clearUnreadFinishedSession(storedId)
  }
})

/** Session key of the focused session (a tile's bound key, else the active one). */
export const $focusedRuntimeId = computed(
  [$focusedStoredSessionId, $activeStoredSessionId, $activeSessionKey, $sessionKeyStates],
  (focused, selected, activeKey, _states) => {
    if (focused && focused !== selected) {
      return runtimeKeyForStoredSession(focused)
    }

    return activeKey
  }
)

/** The focused session's slice. One map, so this is a plain lookup — falling
 *  back to the active session when a tile has no live key yet. */
export const $focusedSessionState = computed(
  [$focusedRuntimeId, $activeSessionKey, $sessionKeyStates],
  (key, activeKey, states) => states[key ?? activeKey] ?? states[activeKey] ?? EMPTY_SESSION_STATE
)

/** The focused chat's project directory — `''` for a detached chat. What the
 *  workspace surfaces (file tree, review, terminal, statusbar) point at, via
 *  `$effectiveCwd` in store/workspace-events, which adds the root fallback. */
export const $focusedCwd = computed($focusedSessionState, state => state.cwd)

/** A PRIMARY navigation homes focus to the workspace — UNLESS the selected id is
 *  already an open TILE (where `focusOpenSession` owns the move). */
export const selectionHomesToWorkspace = (selected: null | string, tiles: readonly SessionTile[]): boolean =>
  !(selected && tiles.some(t => t.storedSessionId === selected))

$activeStoredSessionId.listen(selected => {
  if (!selectionHomesToWorkspace(selected, $sessionKeyTabs.get())) {
    return
  }

  // `null`, not the workspace's group, on purpose: this fires on EVERY primary
  // navigation (a sidebar row, a deep link, a delete, a profile switch), and
  // claiming a zone here would make ⌃Tab cycle the main strip instead of opening
  // the recent-session HUD, and ⌥1-9 activate tabs instead of jumping to recent
  // sessions. An explicit act — `focusWorkspaceSession` — claims the zone.
  noteActiveTreeGroup(null)
  revealTreePane(WORKSPACE_PANE_ID)
})
