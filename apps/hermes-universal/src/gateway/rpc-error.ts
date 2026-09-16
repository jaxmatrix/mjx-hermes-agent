/**
 * Reading the JSON-RPC `error.code` off a rejected gateway RPC.
 *
 * Why the code matters: every "does this backend predate the method?" test used
 * to pattern-match English prose (`isMissingRpcMethod` in lib/gateway-rpc.ts),
 * and that match is both too narrow (a gateway that words `-32601` a fifth way
 * reads as a hard failure) and too wide (a genuine handler failure whose message
 * merely QUOTES a nested `-32601` — an MCP server behind a tool, say — reads as
 * "this backend is old" and permanently latches a degraded surface). The code is
 * on the wire in every one of those cases; keeping it is the fix.
 *
 * WHY THIS IS DUCK-TYPED (MJXHRM-530). Universal used to mint its own
 * `GatewayRpcError` from its own vendored client. The client is now
 * `@hermes/shared`'s, which rejects with ITS own class — `JsonRpcGatewayError`.
 * The two agree on the contract and differ only in the class name, so an
 * `instanceof` accessor would have gone silently null for every rejection the
 * moment the transport was swapped: `isMissingRpcMethod` would fall back to
 * prose, and the four stores that branch on a numeric code (explorer-path,
 * plugin-install, projects, pet-gallery) would read "the gateway did not say"
 * for codes that were right there on the frame. Reading `.code` structurally is
 * what makes the swap invisible to all 49 call sites.
 *
 * `GatewayRpcError` is kept because the app's tests construct it to stand in for
 * a gateway rejection; it is no longer thrown by the transport.
 *
 * Lives in its own module, with no imports, so both the predicates that read it
 * and the stores that branch on it can depend on it without a cycle.
 */

/** JSON-RPC 2.0 "Method not found". `tui_gateway/server.py handle_request()`
 *  answers exactly this for a method it has no handler for. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601

export class GatewayRpcError extends Error {
  /** `error.code` from the JSON-RPC frame; null when the frame omitted it. */
  readonly code: null | number
  /** `error.data`, untouched. Nothing reads it yet — it is kept so a future
   *  structured refusal does not need this class changed again. */
  readonly data: unknown

  constructor(message: string, code: null | number = null, data: unknown = null) {
    super(message)
    this.name = 'GatewayRpcError'
    this.code = code
    this.data = data
  }
}

/**
 * The JSON-RPC code behind a rejection, or null when there is none.
 *
 * Null is NOT "no error": it means the rejection never came off the wire as a
 * JSON-RPC error frame (a transport failure, a timeout, a locally thrown
 * Error), so a caller that wants to know what the gateway said has to fall back
 * to the message.
 *
 * `DOMException` is excluded rather than left to the structural check. It
 * carries a LEGACY numeric `code` of its own that has nothing to do with
 * JSON-RPC (an `AbortError` reads 20), and the channel rejects an aborted call
 * with exactly that — so without this guard every cancelled request would
 * report a gateway code the gateway never sent.
 */
export function gatewayRpcErrorCode(error: unknown): null | number {
  if (!error || typeof error !== 'object') {
    return null
  }

  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return null
  }

  const { code } = error as { code?: unknown }

  return typeof code === 'number' ? code : null
}
