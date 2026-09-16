/**
 * THE consumer of server→client requests (MJXHRM-520).
 *
 * The backend asks the renderer a question and PARKS the agent thread until it
 * is answered (`tui_gateway/server_requests.py`). Universal's forked client
 * used to drop those frames on the floor — an `srq-…` id was looked up in the
 * pending-call map, found nothing, and returned — so every approval, clarify,
 * sudo, secret and MCP-setup prompt the merged backend raised went unanswered
 * until its deadline expired. This module is the other half of the fix: the
 * shared channel now DELIVERS the request, and this decides what to do with it.
 *
 * Three families, three dispositions:
 *
 *  - CARDS (clarify, approval, sudo, secret, mcp.setup) park a per-session
 *    prompt and wait for the user. The request id IS the card's identity, so a
 *    replay after a reconnect re-arms the very same card rather than opening a
 *    second one.
 *  - BRIDGES (terminal.read, window.read, preview.read, preview.act, tour) are
 *    answered immediately from a registered reader/driver, with no UI —
 *    delegated to `store/agent-read-requests.ts`, which owns the registries and
 *    MJXHRM-472's read/drive asymmetry.
 *  - DECLINED (vault.unlock_prompt, vault.save_login, vault.code) return
 *    `false`. The channel then answers `-32601` in the same tick, so the tool
 *    fails FAST instead of waiting out its deadline against a client that has
 *    no vault UI. Building that UI is MJXHRM-522; declining is what ui-tui does
 *    for the same reason, and it is the security-positive default — no
 *    half-built credential surface.
 *
 * Registered by PUSH, not pull: this module self-registers with
 * `addServerRequestHandler` at import, exactly as `store/event-router.ts` does
 * for events. `store/gateway.ts` must not import the session/prompt graph — a
 * static import there reorders module init and trips the `@/hermes`
 * `_apiProfile` TDZ cycle in tests.
 */

import type { GatewayEvent, ServerRequest } from '@/gateway'
import { translateNow } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { answerAgentBridgeRequest } from '@/store/agent-read-requests'
import { ackApprovalReceived, readApprovalPayload } from '@/store/approvals'
import { normalizeQuestions, readChoices, readLockedAnswers } from '@/store/clarify'
import { addGatewayEventListener, addServerRequestHandler } from '@/store/gateway'
import { readMcpSetupAction } from '@/store/mcp-setup'
import { dispatchNativeNotification } from '@/store/native-notifications'
import { setPetActivity } from '@/store/pet'
import {
  clearSessionApproval,
  clearSessionClarify,
  clearSessionMcpSetup,
  clearSessionSecret,
  clearSessionSudo,
  sessionApprovalRequest,
  sessionAwaitingInput,
  sessionClarifyRequest,
  sessionMcpSetupRequest,
  sessionSecretRequest,
  sessionSudoRequest,
  setSessionApproval,
  setSessionClarify,
  setSessionMcpSetup,
  setSessionSecret,
  setSessionSudo
} from '@/store/prompts'
import { forgetServerRequest, rememberServerRequest } from '@/store/server-requests'
import { reduceSessionState } from '@/store/session-reducer'
import { $activeSessionKey, $sessionStates, ensureSessionSlice, updateSession } from '@/store/session-state-types'
import type { PendingApprovalPayload } from '@/types/hermes'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The methods universal deliberately does not answer — see the header. */
const DECLINED_METHODS = new Set(['vault.code', 'vault.save_login', 'vault.unlock_prompt'])

/**
 * The session slice a request belongs to, created if this client has never
 * seen it.
 *
 * Fails OPEN, unlike the event router, and for the reason the event router
 * carves blocking prompts out of its own fail-closed rule: the agent is parked
 * in `server_requests.send()` waiting for this answer, so dropping the request
 * because the session is unknown — a background turn, a cold reattach — hangs
 * that agent for its whole deadline with nothing on screen to answer.
 */
function sliceFor(sessionId: string): string {
  if (sessionId && !(sessionId in $sessionStates.get())) {
    ensureSessionSlice(sessionId)
  }

  return sessionId
}

/**
 * Mark the session as parked on the user.
 *
 * The pet's waiting pose moves with it. That pose used to be driven from the
 * `*.request` events in `store/event-router.ts`; those events are gone, so the
 * arrival of the REQUEST is now the only moment that knows the turn has stopped
 * for input. It is set only for the session on screen, because the pet reflects
 * what the user is looking at — a background session's prompt must not put it
 * in the waiting pose.
 */
function markNeedsInput(key: string): void {
  if (!key) {
    return
  }

  updateSession(key, state => ({ ...state, needsInput: true }))

  if (key === $activeSessionKey.get()) {
    setPetActivity({ awaitingInput: true })
  }
}

/**
 * Raise the native notification for a prompt, unless this is a replay.
 *
 * `replayed` is set by the shared channel when the request came back through
 * `open_requests` after a reconnect rather than arriving live. The card is
 * already on screen in that case, so re-notifying would buzz the user again for
 * a question they are already looking at.
 */
function notifyInput(request: ServerRequest, key: string, body: string): void {
  if (request.replayed) {
    return
  }

  dispatchNativeNotification({
    body,
    kind: 'input',
    sessionId: key || null,
    title: translateNow('notifications.native.inputTitle')
  })
  void triggerHaptic('warning')
}

/**
 * Upsert the synthetic tool row a card renders inside.
 *
 * `tool.start` carries the model's `tool_call_id` while this request carries
 * its own id, so the two rows correlate on their content (`question` /
 * `server`) rather than on the id — see `store/session-reducer.ts`. Going
 * through the SAME reducer case the old event took is what keeps a replayed row
 * identical to a live one, and what makes this an upsert rather than a second
 * card.
 */
function upsertPromptRow(key: string, type: string, payload: Record<string, unknown>): void {
  if (!key) {
    return
  }

  updateSession(key, state => reduceSessionState(state, { type } as GatewayEvent, payload))
}

function handleClarify(request: ServerRequest, key: string): void {
  const p = request.params
  const questions = normalizeQuestions(p.questions)
  const question = str(p.question)

  // Nothing renderable means nothing answerable. Skip rather than park a card
  // the user cannot act on — '' is the clarify tool's own "skipped" answer.
  if (!question && questions.length === 0) {
    request.respond({ answer: '' })

    return
  }

  rememberServerRequest(request)
  setSessionClarify(
    key,
    questions.length > 0
      ? {
          requestId: request.id,
          // A batch carries no top-level question; the card reads `questions`.
          question: '',
          choices: null,
          questions,
          // Present only on a reconnect replay of a partly-answered batch — the
          // locks the server already accepted — never on a live request.
          lockedAnswers: readLockedAnswers(p.answers)
        }
      : {
          requestId: request.id,
          question,
          choices: readChoices('gateway', question, p.choices),
          ...(p.multi_select === true ? { multiSelect: true } : {})
        }
  )
  upsertPromptRow(key, 'clarify.request', { ...p, request_id: request.id })
  markNeedsInput(key)
  notifyInput(request, key, questions.length > 0 ? questions.map(entry => entry.question).join(' · ') : question)
}

function handleApproval(request: ServerRequest, key: string): void {
  // ONE reader for the request params and for the `approval.pending` /
  // `pending_approval` replays: all three are the same `_approval_request_payload`
  // shape server-side, and a client that parsed them differently would answer a
  // replayed approval with a different request_id than the live one. The cast is
  // the structural bridge between the generic request-params bag and that named
  // payload type; the reader itself validates every field it reads.
  const approval = readApprovalPayload(request.params as PendingApprovalPayload)

  rememberServerRequest(request)
  setSessionApproval(key, { ...approval, serverRequestId: request.id })
  // Session-scoped: `approval.received` resolves through `_sess()`, so it needs
  // the runtime id the gateway knows, which is this request's session.
  void ackApprovalReceived(key, approval.requestId)
  markNeedsInput(key)

  if (!request.replayed) {
    dispatchNativeNotification({
      body: str(request.params.command) || str(request.params.description),
      kind: 'approval',
      sessionId: key || null,
      title: translateNow('notifications.native.approvalTitle')
    })
    void triggerHaptic('warning')
  }
}

function handleSudo(request: ServerRequest, key: string): void {
  rememberServerRequest(request)
  // `EmptyRequestParams`: the backend sends nothing but the session. The prompt
  // text the old `sudo.request` event carried is gone from the wire, so the bar
  // supplies its own copy.
  setSessionSudo(key, { requestId: request.id })
  markNeedsInput(key)
  notifyInput(request, key, translateNow('notifications.native.inputBody'))
}

function handleSecret(request: ServerRequest, key: string): void {
  const p = request.params
  const envVar = str(p.env_var)
  const prompt = str(p.prompt)

  rememberServerRequest(request)
  setSessionSecret(key, { requestId: request.id, envVar, prompt })
  markNeedsInput(key)
  notifyInput(request, key, prompt || envVar || translateNow('notifications.native.inputBody'))
}

function handleMcpSetup(request: ServerRequest, key: string): void {
  const p = request.params
  const server = str(p.server).trim()
  const action = readMcpSetupAction(p.action)
  const reason = str(p.reason)

  // Without a server name the card would ask the user to consent to installing
  // "". The tool requires `server` before it ever calls back, so this can only
  // be version skew — answer empty rather than render an unanswerable card.
  if (!server) {
    request.respond({ value: '' })

    return
  }

  rememberServerRequest(request)
  setSessionMcpSetup(key, { requestId: request.id, action, reason, server })
  upsertPromptRow(key, 'mcp.setup.request', { action, reason, request_id: request.id, server })
  markNeedsInput(key)
  notifyInput(request, key, reason || server)
}

/**
 * Dispatch one server→client request.
 *
 * `false` means "universal cannot answer this" and is the signal the shared
 * channel turns into a `-32601` — so every method is either answered here or
 * explicitly declined, and none is left to time out.
 */
export function handleServerRequest(request: ServerRequest): boolean {
  if (DECLINED_METHODS.has(request.method)) {
    return false
  }

  if (answerAgentBridgeRequest(request, $activeSessionKey.get())) {
    return true
  }

  const key = sliceFor(str(request.params.session_id))

  switch (request.method) {
    case 'approval':
      handleApproval(request, key)

      return true

    case 'clarify':
      handleClarify(request, key)

      return true

    case 'mcp.setup':
      handleMcpSetup(request, key)

      return true

    case 'secret':
      handleSecret(request, key)

      return true

    case 'sudo':
      handleSudo(request, key)

      return true

    default:
      return false
  }
}

/**
 * The backend WITHDRAWING an open request (`request.cancel`).
 *
 * The one event left in this family. It fires when a request's wait ends
 * without an answer — a timeout, a `/stop`, the session closing — and it is the
 * replacement for the whole retired `*.expire` family. Tear down whichever card
 * carries that id.
 *
 * Correlated on the ID ALONE, never on the session: a session can hold two
 * prompts at once, and a cancel that arrived late for the older one must not
 * erase the newer one the user is now looking at. Desktop records the same
 * reasoning in its `gateway-event/input-requests.ts`.
 */
export function handleRequestCancel(event: GatewayEvent): void {
  if (event.type !== 'request.cancel') {
    return
  }

  const id = str((event.payload as { id?: unknown } | undefined)?.id)

  if (!id) {
    return
  }

  forgetServerRequest(id)

  const states = $sessionStates.get()

  for (const key of Object.keys(states)) {
    if (sessionClarifyRequest(key).get()?.requestId === id) {
      clearSessionClarify(key)
    } else if (sessionApprovalRequest(key).get()?.serverRequestId === id) {
      clearSessionApproval(key)
    } else if (sessionSudoRequest(key).get()?.requestId === id) {
      clearSessionSudo(key)
    } else if (sessionSecretRequest(key).get()?.requestId === id) {
      clearSessionSecret(key)
    } else if (sessionMcpSetupRequest(key).get()?.requestId === id) {
      clearSessionMcpSetup(key)
    } else {
      continue
    }

    // The turn is no longer parked on the user — unless this session still holds
    // another prompt, which is why the aggregate is what decides the pose.
    if (key === $activeSessionKey.get() && !sessionAwaitingInput(key).get()) {
      setPetActivity({ awaitingInput: false })
    }
  }
}

// Self-register at import, like store/event-router.ts. Nothing else consumes
// the request stream, so a module that is loaded but not listening would leave
// every blocking prompt unanswered — too important to depend on some UI module
// happening to be in the import graph.
addServerRequestHandler(handleServerRequest)
addGatewayEventListener(handleRequestCancel)
