/**
 * The `setup_mcp` consent bridge's non-render half.
 *
 * The pending request itself lives in `store/prompts.ts` alongside the other
 * blocking prompts — that is what makes it survive a cold resume's runtime-id
 * rotation (MJXHRM-207), which desktop's standalone `store/mcp-setup.ts` atom
 * does not. What lives HERE is everything around it: reading the wire payload
 * into a request, putting one back after a reconnect, and answering one without
 * the user ever touching the card.
 *
 * The hazard this module exists for: `setup_mcp` parks the agent in the
 * gateway's `_block` for TEN MINUTES (`tui_gateway/server.py`, `timeout=600` —
 * the longest budget of any bridge, because the flow can include typing an API
 * key or a browser OAuth round-trip). An unanswered card is not a decline:
 * `tools/setup_mcp_tool.py` returns `{"status": "unanswered"}` and instructs the
 * model not to retry. So every way the card can go away has to answer.
 */

import type { GatewayEvent } from '@/gateway'
import { coerceText } from '@/lib/chat-messages'
import { type McpSetupOutcome, respondMcpSetup } from '@/lib/gateway-rpc'
import { clearAwaitingInputPose } from '@/store/chat'
import { notifyError } from '@/store/notifications'
import {
  clearSessionMcpSetup,
  type McpSetupAction,
  type McpSetupRequest,
  sessionMcpSetupRequest,
  setSessionMcpSetup
} from '@/store/prompts'
import { reduceSessionState } from '@/store/session-reducer'
import { updateSession } from '@/store/session-state-types'
import type { SessionResumeResponse } from '@/types/hermes'

/**
 * Coerce the wire's `action` into the closed set the card can render.
 *
 * The gateway forwards the model's own string (`_block("mcp.setup.request",
 * sid, {"server": server, "action": action, ...})`) and the tool's own
 * validation happens on the RETURN leg, not before the emit — so an action the
 * schema never allowed still reaches the client. `install` is the tool's own
 * default for a missing/garbage value, and it is the only action that is safe
 * to guess: it prompts for everything it needs, where a wrong `enable` would
 * silently flip a server the user never configured.
 */
export function readMcpSetupAction(value: unknown): McpSetupAction {
  return value === 'enable' || value === 'authorize' ? value : 'install'
}

/** Read a `mcp.setup.request` payload into a request, or null if unrenderable. */
export function readMcpSetupRequest(payload: Record<string, unknown>): McpSetupRequest | null {
  // Trimmed, and the reducer's row guard trims identically: `coerceText` only
  // coerces, so a whitespace-only `server` is truthy and would render a card
  // asking the user to consent to installing "   ".
  const requestId = coerceText(payload.request_id).trim()
  const server = coerceText(payload.server).trim()

  // Both halves are load-bearing and neither has a fallback: without the id
  // nothing can ever answer, and without a server name the card would ask the
  // user to consent to installing "". The tool requires `server` before it ever
  // calls the callback, so this can only be a version skew — declining to
  // render lets the 600s timeout report `unanswered`, which is at least true.
  if (!requestId || !server) {
    return null
  }

  return { action: readMcpSetupAction(payload.action), reason: coerceText(payload.reason), requestId, server }
}

/** Is an MCP setup card parked on this session right now? Imperative, for the composer. */
export const hasMcpSetupRequest = (key: null | string | undefined): boolean =>
  Boolean(key && sessionMcpSetupRequest(key).get())

/**
 * Answer the parked setup card `declined` on the user's behalf.
 *
 * Sending a real message instead of touching the card IS the answer "not now" —
 * exactly the stance `skipClarifyRequest` takes one prompt over. Without it the
 * follow-up rides behind an agent parked inside its tool batch and nothing
 * happens for ten minutes, with the words already gone from the composer.
 *
 * `declined` rather than an empty answer: the tool distinguishes the two, and
 * only `declined` carries "the user said no" (it also tells the model never to
 * offer that server again this turn). An empty answer would be indistinguishable
 * from a timeout at the tool boundary but is NOT one — the tool would read it as
 * a real, blank outcome.
 *
 * Cleared FIRST so a second Enter can't answer twice, and never rejects: this is
 * fire-and-forget beside the real send. But not silent either (MJXHRM-418) — a
 * skip that did not land puts the card BACK and says so, because with the card
 * torn down nothing else could ever answer it.
 */
export async function skipMcpSetupRequest(key: null | string | undefined): Promise<boolean> {
  const request = key ? sessionMcpSetupRequest(key).get() : null

  if (!key || !request) {
    return false
  }

  clearSessionMcpSetup(key)
  clearAwaitingInputPose(key)

  try {
    await respondMcpSetup(request.requestId, { server: request.server, status: 'declined' })
  } catch (error) {
    // Only if nothing newer has taken the slot — restoring over a fresh request
    // would make THAT one unanswerable.
    if (!sessionMcpSetupRequest(key).get()) {
      setSessionMcpSetup(key, request)
    }

    notifyError(error, 'The MCP setup card could not be dismissed — answer it to unblock the agent')
  }

  return true
}

/** The outcome statuses the card sends. `unanswered` is the TOOL's own word for
 *  a timeout and is never sent by a client. */
export type McpSetupStatus = 'authorized' | 'declined' | 'enabled' | 'error' | 'installed'

/** Narrow `McpSetupOutcome` (whose `status` is a bare string on the 444 helper)
 *  to what this client actually produces. */
export interface McpSetupClientOutcome extends McpSetupOutcome {
  server: string
  status: McpSetupStatus
}

/**
 * Put back the setup card a resumed session is still parked on.
 *
 * `mcp.setup.request` is emitted ONCE with no replay buffer, and a parked turn
 * is not in the committed transcript — so a client that cold-opens (or reloads
 * into) a waiting session has neither the server name nor the `request_id` it
 * must answer with, and the agent stays in `_block` for the full ten minutes.
 * The gateway describes the parked prompt on `session.resume` as
 * `pending_prompt: {event, payload}` (`_session_pending_prompt`), which is
 * generic across every blocking bridge — this is the `mcp.setup.request` arm of
 * the same replay `applyResumedClarify` performs for clarify.
 *
 * Idempotent by construction: the store entry is a replace and the reducer
 * upserts its row under the same `request_id`, so a session that still holds a
 * live card from before the reconnect keeps ONE.
 */
export function applyResumedMcpSetup(key: string, resumed: Pick<SessionResumeResponse, 'pending_prompt'>): void {
  const pending = resumed.pending_prompt

  if (!pending || pending.event !== 'mcp.setup.request') {
    return
  }

  const payload = (pending.payload ?? {}) as Record<string, unknown>
  const request = readMcpSetupRequest(payload)

  if (!request) {
    return
  }

  setSessionMcpSetup(key, request)
  updateSession(key, state =>
    reduceSessionState(state, { type: 'mcp.setup.request' } as GatewayEvent, payload as Record<string, unknown>)
  )
}
