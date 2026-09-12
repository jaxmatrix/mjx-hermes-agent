import { atom } from '@/store/atom'

import { $connectionReady } from './connection-ready'
import { $activeGatewayProfile, normalizeProfileKey, selectProfile } from './profile'
import {
  adoptLiveSession,
  knownSessionProfile,
  markPluginOwnedSession,
  openSession,
  rememberSessionProfile,
  resolveSessionProfile
} from './session'
import { $sessionStates, runtimeKeyForStoredSession } from './session-state-types'
import { focusOpenSession } from './session-states'
import { awaitSessionPainted, SessionWakeError } from './transcript-cache-sync'

/**
 * `host.openSession(storedId)` — the ONE door a plugin has to a conversation.
 *
 * Desktop's equivalent is ~180 lines of hydration planning. This one is short
 * because MJXHRM-480 already built the two pieces it would otherwise have to
 * re-derive: `openSession` promotes a warm session SYNCHRONOUSLY (rule 18 — no
 * `session.resume` at all), and `awaitSessionPainted` is THE wake predicate for
 * the whole app. Neither is re-implemented here, and a second wake predicate is
 * exactly what 480 §9.2 forbids.
 *
 * What this deliberately does NOT expose is a bare resume. A plugin calling
 * `session.resume` itself would bypass the three id spaces and the hydration
 * plan (rules 17, 18), which is why `requestSessionResume` is not an SDK export
 * and this is.
 */

/** Why an open did not finish. Each is a different thing for a caller to do. */
export type PluginOpenSessionError =
  | /** The wake timed out twice. Retrying immediately will not help. */ 'exhausted'
  | /** Nothing to open it on — the gateway is not ready. */ 'no-gateway'
  | /** The profile switch never settled. */ 'profile-unavailable'
  | /** The user moved on mid-open. NOT an error to shout about. */ 'superseded'

export interface PluginOpenSessionOptions {
  /** Whose session this is. Resolved from the session itself when omitted. */
  profile?: null | string
  /** Bring it to the front once it is real. */
  focus?: boolean
  /**
   * A plugin's HIDDEN session — a bot's forever-chat. Never remembered as the
   * profile's place to land at boot, so it is never restored into the main pane
   * as an ordinary chat.
   */
  hidden?: boolean
  /**
   * Whether this conversation is expected to HAVE a transcript.
   *
   * The wake predicate branches on it (`transcript-cache-sync.ts`): `true`
   * completes on transcript paint, `false` on the runtime binding. A session
   * with no messages can only ever satisfy the second — a brand-new one waits
   * out both budgets and reports `exhausted`, which is a 40-second hang where
   * the honest answer is "it is open and empty".
   *
   * Defaults to `true`: every caller that does not know is opening something a
   * user has talked in.
   */
  expectHistory?: boolean
  timeoutMs?: number
}

export type PluginOpenSessionResult =
  | { ok: false; error: PluginOpenSessionError; exhausted?: boolean }
  | { ok: true; storedSessionId: string }

const DEFAULT_OPEN_TIMEOUT_MS = 20_000
const PROFILE_SWITCH_TIMEOUT_MS = 5_000

/**
 * The session whose wake ran out of budget twice.
 *
 * An ATOM rather than a setter on the SDK: `setResumeExhaustedSessionId` would
 * let a plugin forge the state that suppresses a retry. It is reported through
 * `PluginOpenSessionResult.exhausted` instead, and written only here.
 */
export const $resumeExhaustedSessionId = atom<null | string>(null)

/**
 * Point the app at `profile` and wait for the switch to settle.
 *
 * Universal has no `openGatewayForProfile`; the equivalent act is the profile
 * SWITCH, and a caller that does not wait would resolve the session's cwd and
 * project scope under the outgoing profile.
 */
export async function warmProfile(profile: null | string, timeoutMs = PROFILE_SWITCH_TIMEOUT_MS): Promise<boolean> {
  const wanted = normalizeProfileKey(profile)

  if ($activeGatewayProfile.get() === wanted) {
    return true
  }

  selectProfile(wanted)

  // `selectProfile` writes the atom synchronously, so the switch has very often
  // ALREADY landed by the time we get here. Checked before subscribing: a
  // `subscribe` callback that fires immediately and then reaches for its own
  // still-uninitialised disposer is a TDZ throw, not a fast path.
  if ($activeGatewayProfile.get() === wanted) {
    return true
  }

  return new Promise<boolean>(resolve => {
    let settled = false
    let unsubscribe: (() => void) | undefined

    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        unsubscribe?.()
        resolve(ok)
      }
    }

    const timer = setTimeout(() => finish(false), timeoutMs)

    unsubscribe = $activeGatewayProfile.subscribe(active => {
      if (active === wanted) {
        finish(true)
      }
    })

    // A subscription that resolved on its immediate call left `unsubscribe`
    // unset above; drop it now rather than leaking a live listener.
    if (settled) {
      unsubscribe()
    }
  })
}

/** The canonical stored id after the open. A compaction can rotate it while the
 *  resume is in flight, so it is read back off the slice rather than echoed. */
function canonicalStoredId(storedSessionId: string): string {
  const key = runtimeKeyForStoredSession(storedSessionId)

  return (key ? $sessionStates.get()[key]?.storedSessionId : null) ?? storedSessionId
}

export async function openPluginSession(
  storedSessionId: string,
  options: PluginOpenSessionOptions = {}
): Promise<PluginOpenSessionResult> {
  const { expectHistory = true, focus = true, timeoutMs = DEFAULT_OPEN_TIMEOUT_MS } = options

  // Cheap pre-check rather than a second route resolution: the router is 480's
  // and `openSession` already dispatches through it. Asking it to resolve here
  // as well would be a second routing decision for one act.
  if (!$connectionReady.get()) {
    return { error: 'no-gateway', ok: false }
  }

  // The caller KNOWS whose session this is. Recording it before the open is what
  // lets the hydrate scope its transcript read and its resume to that profile: a
  // session no listing contains — a plugin's hidden one — has no row to resolve
  // an owner from, and a probe that misses routes both to whichever database is
  // live.
  if (options.profile) {
    rememberSessionProfile(storedSessionId, options.profile)
  }

  // BEFORE `openSession`: its active-id write is what the last-session subscriber
  // reacts to.
  if (options.hidden) {
    markPluginOwnedSession(storedSessionId)
  }

  const owner = options.profile ?? knownSessionProfile(storedSessionId) ?? (await resolveSessionProfile(storedSessionId))

  if (owner && normalizeProfileKey(owner) !== $activeGatewayProfile.get() && !(await warmProfile(owner))) {
    return { error: 'profile-unavailable', ok: false }
  }

  // Warm promote is SYNCHRONOUS and issues no resume (rule 18); a cold one
  // hydrates. Either way the wake below is what says it is real.
  await openSession(storedSessionId)

  const wake = async () => awaitSessionPainted(storedSessionId, { expectHistory, timeoutMs })

  try {
    await wake()
  } catch (error) {
    if (!(error instanceof SessionWakeError)) {
      throw error
    }

    // The user moved on. Not a failure to report — nothing is wrong.
    if (error.reason === 'superseded') {
      return { error: 'superseded', ok: false }
    }

    // ONE retry, and only for the transcript phase: a hydration that ran out of
    // budget is usually a slow fetch, while an ACTIVATION that never bound is a
    // wedged dial that a second wait will not fix.
    if (error.phase !== 'hydration') {
      $resumeExhaustedSessionId.set(storedSessionId)

      return { error: 'exhausted', exhausted: true, ok: false }
    }

    try {
      await wake()
    } catch {
      $resumeExhaustedSessionId.set(storedSessionId)

      return { error: 'exhausted', exhausted: true, ok: false }
    }
  }

  $resumeExhaustedSessionId.set(null)

  if (focus) {
    focusOpenSession(storedSessionId)
  }

  return { ok: true, storedSessionId: canonicalStoredId(storedSessionId) }
}

/** A session a plugin has JUST created with `session.create`, as it answered. */
export interface PluginCreatedSession {
  /** The RUNTIME handle — the id the gateway is holding live right now. */
  runtimeSessionId: string
  /** The DURABLE row key. What the slice is remembered and routed by. */
  storedSessionId: string
  /** The profile it was created under, which the client could not otherwise
   *  learn for a session no listing contains. */
  profile?: null | string
  cwd?: null | string
  /** A plugin's hidden session: never remembered as the profile's place. */
  hidden?: boolean
}

/**
 * `host.openCreatedSession(created)` — show a session the plugin just created.
 *
 * The companion to `openPluginSession`, and the difference is the whole reason
 * it exists: that door RESUMES a stored session, and a session created a moment
 * ago has nothing to resume. It is live on the gateway already, under the
 * runtime id `session.create` handed back, so it is bound straight to that id —
 * no resume, no transcript wait, and no profile switch.
 *
 * A plugin that routed a fresh session through `openPluginSession` instead got a
 * cold hydrate built for sidebar sessions: an owner it could not resolve for a
 * hidden row, a resume against the wrong database, and a slice left looking open
 * with nothing live behind it.
 */
export function openCreatedPluginSession(
  created: PluginCreatedSession,
  options: { focus?: boolean } = {}
): PluginOpenSessionResult {
  if (!$connectionReady.get()) {
    return { error: 'no-gateway', ok: false }
  }

  adoptLiveSession(created)
  $resumeExhaustedSessionId.set(null)

  if (options.focus !== false) {
    focusOpenSession(created.storedSessionId)
  }

  return { ok: true, storedSessionId: created.storedSessionId }
}
