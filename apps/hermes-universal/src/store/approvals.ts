/**
 * The approval queue's reconnect + correlation seams (MJXHRM-458).
 *
 * An approval is NOT a `_block()` prompt: it queues in `tools/approval`'s
 * per-session `_gateway_queues` and the agent thread waits on its own Event.
 * Two consequences the client has to respect and did not:
 *
 *  - The queue can hold MORE THAN ONE approval. `approval.request` is emitted
 *    per enqueue and the prompt store keeps one entry per session, so the
 *    second event overwrote the first — while `approval.respond` with no
 *    `request_id` resolves the OLDEST (`resolve_gateway_approval`'s FIFO
 *    branch). The bar showed command B and approved command A. Coalescing
 *    (08d9828503) makes this worse, not better: identical prompts are now
 *    merged server-side, so anything still queued alongside is a DIFFERENT
 *    command.
 *  - Nothing re-emits the ones left behind. Answering the visible approval
 *    leaves the rest queued and invisible until their own timeout, so
 *    `approval.pending` has to be pulled after each answer — and
 *    `pending_approval` read on resume, for the prompt raised while this
 *    client's transport was detached.
 */

import { requestGateway } from '@/store/gateway'
import { type ApprovalRequest, setSessionApproval } from '@/store/prompts'
import type { PendingApprovalPayload, SessionResumeResponse } from '@/types/hermes'

/** The client-side request an `approval.request` payload (or its replay
 *  snapshot) describes. Both shapes come from `_approval_request_payload`. */
export function readApprovalPayload(payload: PendingApprovalPayload): ApprovalRequest {
  return {
    requestId: typeof payload.request_id === 'string' ? payload.request_id : undefined,
    command: typeof payload.command === 'string' ? payload.command : '',
    description: typeof payload.description === 'string' ? payload.description : 'dangerous command',
    // false only when a tirith warning forbids it; backend omits it otherwise.
    allowPermanent: payload.allow_permanent !== false,
    choices: Array.isArray(payload.choices)
      ? payload.choices.filter((choice): choice is string => typeof choice === 'string')
      : undefined,
    smartDenied: payload.smart_denied === true
  }
}

/**
 * Tell the gateway this client has the prompt on screen.
 *
 * Fire-and-forget, and deliberately so: `ack_gateway_approval` only sets
 * `entry.acknowledged`, which nothing in the backend reads TODAY — this is
 * protocol parity with desktop (`receiveApprovalRequest`), so a gateway that
 * later re-notifies unacknowledged approvals does not start double-prompting
 * universal. A failure changes nothing the user can see, so it must not
 * surface as an error over a prompt they are trying to answer.
 */
export async function ackApprovalReceived(sessionId: string, requestId: string | undefined): Promise<void> {
  if (!sessionId || !requestId) {
    return
  }

  try {
    await requestGateway('approval.received', { request_id: requestId, session_id: sessionId })
  } catch {
    // Nothing the user can act on, and nothing downstream depends on it.
  }
}

/**
 * Put the next queued approval back on screen, if the session still has one.
 *
 * Called after an answer lands: `resolve_gateway_approval` removes only the
 * one it resolved, and the others were never re-emitted.
 */
export async function replayPendingApproval(sessionId: string, key: string): Promise<boolean> {
  if (!sessionId) {
    return false
  }

  const result = await requestGateway<{ approvals?: PendingApprovalPayload[] }>('approval.pending', {
    session_id: sessionId
  })

  const [pending] = Array.isArray(result?.approvals) ? result.approvals : []

  if (!pending || typeof pending.request_id !== 'string') {
    return false
  }

  const request = readApprovalPayload(pending)

  setSessionApproval(key, request)

  void ackApprovalReceived(sessionId, request.requestId)

  return true
}

/**
 * Restore the approval a resumed session is still parked on.
 *
 * `approval.request` fires once, so a client that cold-opens (or reconnects
 * into) a session already blocked on one has no record of it — the same hole
 * `applyResumedClarify` fills for clarify, and the reason
 * `_live_session_payload` reports `pending_approval` at all.
 */
export function applyResumedApproval(key: string, resumed: Pick<SessionResumeResponse, 'pending_approval'>): boolean {
  const pending = resumed.pending_approval

  if (!pending || typeof pending.request_id !== 'string') {
    return false
  }

  setSessionApproval(key, readApprovalPayload(pending))

  return true
}
