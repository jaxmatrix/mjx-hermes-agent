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

import { clearAwaitingInputPose } from '@/store/chat'
import { notifyError } from '@/store/notifications'
import { clearSessionMcpSetup, type McpSetupAction, sessionMcpSetupRequest } from '@/store/prompts'
import { respondToServerRequest } from '@/store/server-requests'

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

// `readMcpSetupRequest` is GONE (MJXHRM-520). It read a `request_id` out of the
// event payload, and the card's identity is now the SERVER REQUEST's own id —
// there is no id in `McpSetupRequestParams` to read. `store/server-request-
// router.ts` builds the request from the params it was handed, which is the one
// place that has both the id and the params.

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
 * fire-and-forget beside the real send.
 *
 * MJXHRM-418's guarantee survives, inverted by the request wire (MJXHRM-520).
 * The old skip could fail IN TRANSIT — an RPC rejection — and had to put the
 * card back, because the agent was still parked for its ten minutes. A response
 * frame cannot fail that way: it is written to the socket the request arrived
 * on, and a write into a dead generation is swallowed because the backend
 * re-delivers or withdraws the request itself. The only failure left is that
 * nothing is open under that id, which means the card was ALREADY withdrawn and
 * the tool has already returned — so restoring it would strand an unanswerable
 * card offering to install a server nothing is waiting on. It stays cleared,
 * and the user is told instead of it vanishing silently.
 */
export async function skipMcpSetupRequest(key: null | string | undefined): Promise<boolean> {
  const request = key ? sessionMcpSetupRequest(key).get() : null

  if (!key || !request) {
    return false
  }

  clearSessionMcpSetup(key)
  clearAwaitingInputPose(key)

  // `ValueResult` — the declared result for `mcp.setup` — carries the outcome as
  // a JSON string under `value`. The old `mcp.setup.respond` method put it under
  // `result` instead, and that method is gone; sending the wrong key here would
  // be a silent no-answer, which for this card means a ten-minute stall.
  if (
    !respondToServerRequest(request.requestId, {
      value: JSON.stringify({ server: request.server, status: 'declined' })
    })
  ) {
    notifyError(
      new Error('that setup card was already withdrawn'),
      'The MCP setup card could not be dismissed — it had already expired'
    )
  }

  return true
}

/** The outcome statuses the card sends. `unanswered` is the TOOL's own word for
 *  a timeout and is never sent by a client. */
export type McpSetupStatus = 'authorized' | 'declined' | 'enabled' | 'error' | 'installed'

/** What the card sends back. `detail`/`tools` ride along for the tool's report. */
export interface McpSetupClientOutcome {
  detail?: string
  server: string
  status: McpSetupStatus
  tools?: string[]
}

// `applyResumedMcpSetup` lived here and is GONE (MJXHRM-520), for the same
// reason as `applyResumedClarify` next door: it read `session.resume`'s
// `pending_prompt`, which the merged backend no longer sends, so it had been a
// silent no-op — a cold-opened parked session rebuilt neither the card nor the
// row while `setup_mcp` sat in its TEN MINUTE block. Still-open cards now come
// back as `open_requests` on the resume result and re-enter through the request
// router, rebuilding both halves via the same path a live request takes.
