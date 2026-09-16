import type { ServerRequest } from '@/gateway'

/**
 * The server→client requests currently open, by request id.
 *
 * These are the backend asking the renderer a question
 * (`tui_gateway/server_requests.py`): clarify, approval, sudo, secret, MCP
 * setup, and the GUI bridges. The agent thread is parked in
 * `server_requests.send()` until one of them is answered, so an unanswered
 * entry here is a turn that is not running.
 *
 * The per-session prompt stores keep only the ID; a card answers through
 * {@link respondToServerRequest}, which routes the response frame back over
 * THE SOCKET THE REQUEST ARRIVED ON. That is what makes the whole "the answer
 * landed on the wrong backend" class structurally impossible here rather than
 * merely guarded: a response is not a new call, it is a reply on an existing
 * correlation, so there is no owner to resolve and nothing to route.
 *
 * A request re-delivered after a reconnect (`open_requests`) carries the SAME
 * id and replaces the entry, so a card that survived the drop answers the new
 * generation rather than a dead one.
 *
 * Mirrors `apps/desktop/src/store/server-requests.ts` and ui-tui's
 * `serverRequestStore.ts` deliberately: three clients, one shape.
 */
const open = new Map<string, ServerRequest>()

export function rememberServerRequest(request: ServerRequest): void {
  open.set(request.id, request)
}

export function forgetServerRequest(id: string): void {
  open.delete(id)
}

/**
 * Answer request `id`.
 *
 * False when nothing is open under that id — it expired, the backend withdrew
 * it with `request.cancel`, or this is the second tap on a card that has
 * already answered. The entry is deleted BEFORE responding, which is what makes
 * a double-tap a local no-op instead of a second frame on the wire (the shared
 * channel and the backend both ignore the second answer too, so this is the
 * first of three defences rather than the only one).
 */
export function respondToServerRequest(id: string | undefined, result: Record<string, unknown>): boolean {
  const request = id ? open.get(id) : undefined

  if (!request || !id) {
    return false
  }

  open.delete(id)
  request.respond(result)

  return true
}

/** Is this request still open? */
export function hasOpenServerRequest(id: string): boolean {
  return open.has(id)
}

/** Test seam — drops every open request. */
export function resetServerRequestsForTests(): void {
  open.clear()
}
