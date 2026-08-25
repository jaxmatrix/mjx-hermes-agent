/**
 * The transcript tail cache's LIFECYCLE: when it is written, when it is dropped,
 * and what "this session is on screen" means for a caller waiting on a wake.
 *
 * Its own module, not a fourth responsibility inside `store/turn-hydration.ts`:
 * that file's header says its three jobs live together BECAUSE their ordering is
 * the point (reconcile, then recover, then journal). Cache writing has no
 * ordering claim of its own — it wants the richest correct copy, whenever that
 * exists — so bolting it on would dilute the one thing that header promises.
 *
 * WRITES happen at two moments, and neither is on the token path:
 *
 *  - the COLD-OPEN REKEY (`hydrating:<id>` → runtime id), where the transcript
 *    is REST (the authority) reconciled with the local live tail and folded with
 *    the crash journal — the richest correct copy the app ever holds;
 *  - TURN SETTLE, the same edge where the crash journal is released: the
 *    terminal frame has landed and the rows are sealed.
 *
 * Both go through a 1 s trailing throttle and read the slice at FLUSH time, so a
 * burst of tiles settling at once costs one write each, one macrotask later —
 * and so the write cannot race the reconcile that the rekey performs
 * synchronously.
 *
 * Side-effect imported from `main.tsx`: this module IS the wiring (recipe 6.5).
 */

import { aliasTranscriptTail, saveTranscriptTail } from '@/lib/transcript-tail-cache'
import {
  $sessionStates,
  addSessionKeyHooks,
  isPlaceholderKey,
  runtimeKeyForStoredSession
} from '@/store/session-state-types'
import { $transcriptPaint } from '@/store/transcript-paint'
import { observeTurnLifecycle } from '@/store/turn-lifecycle'

/** The journal uses 400 ms because it IS on the token path. This is not. */
const SAVE_THROTTLE_MS = 1_000

/** Desktop's `DEFAULT_SESSION_HYDRATION_TIMEOUT_MS`. */
const DEFAULT_WAKE_TIMEOUT_MS = 20_000

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** The stored id each key was last cached under, so a compaction rotation can
 *  leave a one-hop pointer behind for every surface still holding the old id. */
const savedAs = new Map<string, string>()

/**
 * Run `fn` on the next idle slot, or the next macrotask where there is none.
 *
 * `requestIdleCallback` is absent in WebKitGTK and in WKWebView — two of the five
 * targets — so it is feature-detected rather than assumed. The throttle above is
 * the real bound either way; this only keeps the `JSON.stringify` off the frame
 * that settled the turn.
 */
function deferred(fn: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback

  if (idle) {
    idle(fn)

    return
  }

  setTimeout(fn, 0)
}

function flushSave(key: string): void {
  const state = $sessionStates.get()[key]
  const storedSessionId = state?.storedSessionId

  if (!storedSessionId || !state.messages.length) {
    return
  }

  const previous = savedAs.get(key)

  if (saveTranscriptTail(storedSessionId, state.messages) !== 'saved') {
    return
  }

  savedAs.set(key, storedSessionId)

  // An auto-compaction rotates the stored id (MJX-133) and every tile, pane id
  // and persisted blob still names the id from before it. One hop keeps them
  // resolving, exactly as `aliasStoredSessionId` does in memory.
  if (previous && previous !== storedSessionId) {
    aliasTranscriptTail(previous, storedSessionId)
  }
}

function scheduleSave(key: string): void {
  if (saveTimers.has(key)) {
    return
  }

  saveTimers.set(
    key,
    setTimeout(() => {
      saveTimers.delete(key)
      deferred(() => flushSave(key))
    }, SAVE_THROTTLE_MS)
  )
}

addSessionKeyHooks({
  drop: key => {
    savedAs.delete(key)
  },
  rekey: (fromKey, toKey) => {
    savedAs.delete(fromKey)

    // Only a HYDRATING key binding its runtime id is a cold open. A draft taking
    // its issued id has no history worth caching yet, and a live rekey is
    // carrying a turn that will settle and write for itself.
    if (isPlaceholderKey(fromKey) && !isPlaceholderKey(toKey)) {
      scheduleSave(toKey)
    }
  }
})

// The same edge the crash journal is released on: `turn === null` or a settled
// phase both mean the turn has concluded and its rows are sealed.
observeTurnLifecycle(({ key, turn }) => {
  if (turn && turn.phase !== 'settled') {
    return
  }

  scheduleSave(key)
})

// --- the wake predicate ----------------------------------------------------

export type SessionWakeFailure = 'superseded' | 'timeout'

/**
 * A wake that did not complete. `phase` says WHICH budget ran out, because
 * "activation" (no slice, no runtime binding — a wedged dial) and "hydration"
 * (bound, but the transcript never arrived) are different faults with different
 * fixes, and desktop wedged a whole pane by arming its only timer after the
 * unbounded await.
 */
export class SessionWakeError extends Error {
  readonly phase: 'activation' | 'hydration'
  readonly reason: SessionWakeFailure

  constructor(reason: SessionWakeFailure, phase: 'activation' | 'hydration') {
    super(`session wake ${reason} (${phase})`)
    this.name = 'SessionWakeError'
    this.phase = phase
    this.reason = reason
  }
}

export interface AwaitSessionPaintedOptions {
  /** This conversation has history, so the wake completes on TRANSCRIPT PAINT.
   *  An expected-empty one completes on the runtime binding — otherwise a brand
   *  new chat could never satisfy it. */
  expectHistory?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * The slice key serving this stored session.
 *
 * THE SCAN COMES FIRST, and that is not a style choice: `publishSessionState`
 * calls `$sessionStates.set(...)` — which notifies synchronously — and only THEN
 * updates the stored-id reverse index. A subscriber that resolved through the
 * index would therefore see the OLD index on the very publish that created the
 * slice, and a waiter armed before it would never wake, because no second
 * publish is coming. The scan reads only the value the notification carried.
 *
 * The index is still consulted, for the case the scan cannot answer: a lineage
 * ALIAS, where the id names a pre-rotation identity no slice carries any more
 * (MJX-133).
 */
function sessionKeyFor(storedSessionId: string): null | string {
  const states = $sessionStates.get()

  for (const [key, state] of Object.entries(states)) {
    if (state.storedSessionId === storedSessionId) {
      return key
    }
  }

  const aliased = runtimeKeyForStoredSession(storedSessionId)

  return aliased && states[aliased] ? aliased : null
}

/** Does this session have a surface with something real on it? */
function paintedNow(storedSessionId: string, expectHistory: boolean): boolean {
  const key = sessionKeyFor(storedSessionId)
  const state = key ? $sessionStates.get()[key] : undefined

  if (!key || !state) {
    return false
  }

  return expectHistory
    ? state.messages.length > 0 || Boolean($transcriptPaint.get()[key])
    : Boolean(state.runtimeSessionId)
}

function waitFor(
  predicate: () => boolean,
  phase: 'activation' | 'hydration',
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (predicate()) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false

    const finish = (error?: SessionWakeError) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      unsubscribeStates()
      unsubscribePaint()
      signal?.removeEventListener('abort', onAbort)

      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const check = () => {
      if (predicate()) {
        finish()
      }
    }

    const onAbort = () => finish(new SessionWakeError('superseded', phase))
    const timer = setTimeout(() => finish(new SessionWakeError('timeout', phase)), timeoutMs)
    const unsubscribeStates = $sessionStates.subscribe(check)
    const unsubscribePaint = $transcriptPaint.subscribe(check)

    signal?.addEventListener('abort', onAbort)

    // `subscribe` fires immediately, so a predicate already true above has
    // resolved by now.
    check()
  })
}

/**
 * Resolve when the session's surface has something real on it.
 *
 * THE wake predicate for the whole app — a policy function rather than an
 * interface, deliberately: there is exactly one correct answer to "is this
 * surface real yet", and two implementations of it would be precisely the drift
 * desktop's `$activeGatewayRoute` bug was. Consumers extend it through the
 * options object (MJXHRM-455's `host.openSession`, MJXHRM-445's bot wake).
 *
 * The two phases carry SEPARATE budgets: a dial that never handshakes must not
 * be able to consume the transcript's budget before the transcript is even
 * asked for.
 */
export async function awaitSessionPainted(
  storedSessionId: null | string,
  options: AwaitSessionPaintedOptions = {}
): Promise<void> {
  const { expectHistory = false, signal, timeoutMs = DEFAULT_WAKE_TIMEOUT_MS } = options

  if (!storedSessionId) {
    throw new SessionWakeError('superseded', 'activation')
  }

  await waitFor(() => paintedNow(storedSessionId, false), 'activation', timeoutMs, signal)

  if (expectHistory) {
    await waitFor(() => paintedNow(storedSessionId, true), 'hydration', timeoutMs, signal)
  }
}

/** Test seam: drop the pending throttles and the rotation bookkeeping. */
export function __resetTranscriptCacheSync(): void {
  for (const timer of saveTimers.values()) {
    clearTimeout(timer)
  }

  saveTimers.clear()
  savedAs.clear()
}
