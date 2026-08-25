import { requestForSession } from '@/store/session-request-router'
import {
  $sessionStates,
  dropSessionState,
  ensureSessionSlice,
  hydratingKey,
  rekeySession,
  runtimeKeyForStoredSession
} from '@/store/session-state-types'

/**
 * BIND a session this window is not looking at — give it a real
 * `$sessionStates` slice, streaming.
 *
 * `host.openSession` FOCUSES; this does not. A surface that drives several
 * foreign sessions at once (a Bot Mode room's six members) needs their turns,
 * their `busy` flag and their blocking prompts, and needs none of them to steal
 * the screen.
 *
 * The whole point is that this is not a snapshot. A slice minted from a
 * listing is what `store/live-session-registry.ts` refuses to do and says why:
 * a slice is a claim that this client is following the conversation, so it is
 * created by a REAL `session.resume` against the session's own owner. What
 * follows for free:
 *
 *  - `message.delta` / turn-lifecycle frames route into the slice through
 *    `store/event-router.ts` — there is nothing left to poll;
 *  - `approval.request` / `clarify.request` land in `store/prompts.ts` under the
 *    session's key, so a foreign session's questions are answerable in place;
 *  - `$workingSessionIds` answers "is it running" without a request.
 *
 * The sidebar is unaffected: it renders the REST list (`$sessions`), and
 * universal never asks for hidden rows, so a slice for a hidden session lights
 * nothing.
 *
 * `omitMessages` because the transcript's authority is REST (rule 18) — a
 * caller that wants history reads it, and a caller that only wants the live
 * stream should not pay for a replay.
 */
export interface BindSessionOptions {
  /** Owning profile, when it is not the launch one. */
  profile?: null | string
  /** Ask the resume to replay the transcript (default: no — rule 18). */
  withHistory?: boolean
  timeoutMs?: number
}

export type BindSessionResult = { error: string; ok: false } | { ok: true; sessionKey: string }

/**
 * Idempotent: a session already bound resolves its existing key without a
 * second resume. Concurrent callers share one in-flight resume.
 */
const inFlight = new Map<string, Promise<BindSessionResult>>()

export async function bindSessionSlice(
  storedSessionId: string,
  options: BindSessionOptions = {}
): Promise<BindSessionResult> {
  const existing = runtimeKeyForStoredSession(storedSessionId)

  if (existing && $sessionStates.get()[existing]?.runtimeSessionId) {
    return { ok: true, sessionKey: existing }
  }

  const pending = inFlight.get(storedSessionId)

  if (pending) {
    return pending
  }

  const run = (async (): Promise<BindSessionResult> => {
    const placeholder = hydratingKey(storedSessionId)

    ensureSessionSlice(placeholder, { busy: false, storedSessionId })

    try {
      const res = await requestForSession<{ session_id?: string }>(
        storedSessionId,
        'session.resume',
        {
          cols: 96,
          omit_messages: !options.withHistory,
          session_id: storedSessionId
        },
        options.timeoutMs,
        options.profile ?? undefined
      )

      const runtimeSessionId = res.session_id

      if (!runtimeSessionId) {
        dropSessionState(placeholder)

        return { error: 'no-runtime-id', ok: false }
      }

      rekeySession(placeholder, runtimeSessionId, { runtimeSessionId, storedSessionId })

      return { ok: true, sessionKey: runtimeSessionId }
    } catch (error) {
      // The placeholder is dropped rather than left behind: a slice with no
      // transport is exactly the lie this module exists to avoid.
      dropSessionState(placeholder)

      return { error: error instanceof Error ? error.message : String(error), ok: false }
    }
  })()

  inFlight.set(storedSessionId, run)

  try {
    return await run
  } finally {
    inFlight.delete(storedSessionId)
  }
}

/**
 * Drop the slice a `bindSessionSlice` created.
 *
 * Deliberately NOT a `session.set_hidden` or an interrupt: the conversation
 * keeps running on the gateway, this window just stops following it. Closing a
 * room must not cancel the turn it started.
 */
export function releaseSessionSlice(storedSessionId: string): void {
  const key = runtimeKeyForStoredSession(storedSessionId)

  if (key) {
    dropSessionState(key)
  }
}
