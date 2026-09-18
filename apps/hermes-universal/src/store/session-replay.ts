/**
 * REPLAY — what a reconnected socket has to ask for, and what it may trust
 * (MJXHRM-591, invariant 35).
 *
 * The backend already offers everything this needs and universal has never used
 * it: `gateway.ready` carries a `replay_epoch`, every session-scoped frame is
 * stamped with a per-session monotonic `seq`
 * (`tui_gateway/event_replay.py::_stamp_event`), and `session.events.since`
 * hands back the frames after a watermark. No backend change — this is a client
 * that finally reads its own contract.
 *
 * The three answers, and why each is not optional:
 *
 *  * SINCE. A socket that dropped mid-turn missed frames. Asking from the last
 *    `seq` this client actually saw is the only request that cannot skip one.
 *  * EPOCH. A `replay_epoch` different from the one the watermark was taken
 *    under means the backend restarted its event log: the old number addresses
 *    nothing there, and asking with it would return nothing while looking like
 *    "you are up to date". The watermark is RESET and the session re-resumed.
 *  * TRUNCATED. The backend kept fewer frames than the gap. There is no honest
 *    incremental answer, so the transcript is refetched whole.
 *
 * This module is pure: it records what was seen and decides what to ask. The
 * calling and the delivery live with the owning client, so the policy can be
 * tested without a socket.
 */

export interface ReplayCursor {
  /** The highest `seq` this client has seen for the session. */
  seq: number
  /** The `replay_epoch` that watermark was taken under. */
  epoch: null | string
}

/** What a reconnect should do for one bound session. */
export type ReplayPlan =
  /** Ask `session.events.since(session_id, seq)` and fold what comes back. */
  | { kind: 'since'; seq: number }
  /** The log is a different one: forget the watermark and resume the session. */
  | { kind: 'resume' }
  /** More was lost than the backend kept: refetch the transcript whole. */
  | { kind: 'refetch' }

const cursors = new Map<string, ReplayCursor>()
/** The `replay_epoch` each connection's socket last advertised. */
const epochByConnection = new Map<string, null | string>()

/** Record the epoch a connection's socket advertised on `gateway.ready`. */
export function noteConnectionEpoch(connectionId: string, epoch: null | string | undefined): void {
  epochByConnection.set(connectionId, epoch ?? null)
}

/** The epoch a connection's frames are being stamped under, if it said. */
export function connectionEpoch(connectionId: string): null | string {
  return epochByConnection.get(connectionId) ?? null
}

/** The cursor for a session key, or a fresh one. */
export function replayCursor(key: string): ReplayCursor {
  return cursors.get(key) ?? { epoch: null, seq: 0 }
}

/**
 * Record a frame this client has actually folded.
 *
 * Monotonic by construction: a replayed frame that arrives twice, or out of
 * order behind a live one, must not move the watermark backwards and make the
 * next reconnect ask for frames already applied.
 */
export function noteReplaySeq(key: string, seq: null | number | undefined, epoch: null | string = null): void {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) {
    return
  }

  const current = replayCursor(key)

  cursors.set(key, {
    epoch: epoch ?? current.epoch,
    seq: Math.max(current.seq, seq)
  })
}

/** Record the epoch a session's watermark is being taken under. */
export function noteReplayEpoch(key: string, epoch: null | string | undefined): void {
  const current = replayCursor(key)

  cursors.set(key, { epoch: epoch ?? null, seq: current.seq })
}

/** Forget a session's watermark — its slice is gone, or its log is. */
export function forgetReplayCursor(key: string): void {
  cursors.delete(key)
}

/**
 * What to ask for after a reconnect.
 *
 * `epoch` is the one the socket just advertised on `gateway.ready`. A session
 * this client has never stamped a `seq` for has nothing to catch up on
 * incrementally, so it resumes — the same answer a changed epoch gets, and for
 * the same reason: the watermark addresses nothing.
 */
export function planReplay(key: string, epoch: null | string | undefined): ReplayPlan {
  const cursor = replayCursor(key)

  if (cursor.seq <= 0 || !cursor.epoch || (epoch ?? null) !== cursor.epoch) {
    cursors.set(key, { epoch: epoch ?? null, seq: 0 })

    return { kind: 'resume' }
  }

  return { kind: 'since', seq: cursor.seq }
}

/** The shape `session.events.since` answers with. */
export interface SessionEventsSince {
  events?: { seq?: number }[]
  /** The backend kept fewer frames than the gap this asked to cover. */
  truncated?: boolean
  /** Re-delivered blocking requests: the shared channel promises these arrive
   *  BEFORE the result, so a prompt parked in `_block` is answerable again. */
  open_requests?: unknown[]
}

/**
 * Fold a `session.events.since` answer into a decision.
 *
 * `truncated` outranks everything: partial frames on top of a gap would paint a
 * transcript with a hole in it, which reads as the agent having skipped work.
 */
export function readEventsSince(key: string, answer: SessionEventsSince | null | undefined): ReplayPlan | null {
  if (!answer) {
    return null
  }

  if (answer.truncated) {
    cursors.set(key, { epoch: replayCursor(key).epoch, seq: 0 })

    return { kind: 'refetch' }
  }

  for (const event of answer.events ?? []) {
    noteReplaySeq(key, event.seq)
  }

  return null
}

export const __testing = {
  reset: (): void => {
    cursors.clear()
    epochByConnection.clear()
  }
}
