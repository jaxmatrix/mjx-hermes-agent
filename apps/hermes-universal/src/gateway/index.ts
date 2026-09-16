/**
 * The app's gateway facade.
 *
 * The client itself is `@hermes/shared`'s (MJXHRM-530) — universal no longer
 * vendors a copy. This module stays as the seam every `@/gateway` import site
 * already names, so adopting the package did not churn ~40 files, and so the
 * two things that are still LOCAL can sit beside the shared re-exports:
 *
 *  - `./websocket-url`, deliberately forked: it carries universal-only sign-in
 *    errors (`GatewaySignInRequiredError` / `GatewaySignInBusyError`) that
 *    shared does not have, and its resolver signature differs. Unifying it is a
 *    separate concern with its own risk.
 *  - `./rpc-error`, which reads the code off a rejection STRUCTURALLY, so the
 *    shared client's `JsonRpcGatewayError` and the app's own `GatewayRpcError`
 *    are both legible to one accessor.
 *
 * ...and one type, `GatewayEvent`, explained below.
 */
import type { GatewayEventName as BackendGatewayEventName } from '@hermes/shared'

export { GatewayRpcError, gatewayRpcErrorCode, JSON_RPC_METHOD_NOT_FOUND } from './rpc-error'
export {
  buildHermesWebSocketUrl,
  type GatewayAuthMode,
  GatewayReauthRequiredError,
  GatewaySignInBusyError,
  GatewaySignInRequiredError,
  type GatewayWsConnection,
  type HermesWebSocketUrlOptions,
  isGatewayReauthRequired,
  isGatewaySignInBusy,
  isGatewaySignInRequired,
  resolveGatewayWsUrl,
  type ResolveGatewayWsUrlDeps,
  type WebSocketAuthParam
} from './websocket-url'
export type {
  ApprovalRequestParams,
  ApprovalResult,
  ClarifyRequestParams,
  ClarifyResult,
  EmptyRequestParams,
  ClarifyQuestion as GatewayClarifyQuestion,
  McpSetupRequestParams,
  PreviewActRequestParams,
  ReadRangeRequestParams,
  RequestCancelPayload,
  RpcMethods,
  SecretRequestParams,
  ServerRequestMap,
  ServerRequestMethod,
  TourRequestParams,
  ValueResult
} from '@hermes/shared'
export {
  type ConnectionState,
  type GatewayClientOptions,
  type GatewayRequestId,
  type JsonRpcFrame,
  JsonRpcGatewayClient,
  JsonRpcGatewayError,
  RPC_METHODS,
  SERVER_REQUEST_METHODS,
  type ServerRequest,
  type ServerRequestHandler,
  type ServerRequestParams,
  type WebSocketLike
} from '@hermes/shared'
export type { GatewayEventName as BackendGatewayEventName } from '@hermes/shared'

/**
 * An event name as it reaches the app's routers — the generated set, PLUS
 * anything else.
 *
 * Deliberately open, and not the same decision as the transport's. Inside the
 * shared client the name union is closed and should be: it keys the typed
 * `on()` map and the generated payload lookup. But two families of name reach
 * this app's reducers that the backend contract does not declare, and both are
 * correct:
 *
 *  - CLIENT-LOCAL synthetic events. `lib/stream-batch` coalesces a burst of
 *    tokens and replays it through the same reducer as `reasoning.batch`, a
 *    name that exists only in this renderer — so that batching stays a
 *    scheduling concern instead of becoming a second copy of the append logic.
 *  - Names wired AHEAD of the backend, e.g. `plugins.changed`, whose handler
 *    exists so that the release which starts emitting it touches only the
 *    gateway.
 *
 * Closing this union would turn both into type errors, and the only way to
 * silence them would be to delete live handlers for events that are either
 * already flowing or deliberately pre-wired. `(string & {})` keeps the
 * generated names autocompleting while leaving the door open, which is exactly
 * what universal's own envelope did before it consumed the package.
 */
export type GatewayEventName = BackendGatewayEventName | (string & {})

/**
 * One `event` notification's `params`, as the app reads it.
 *
 * Structurally the shared envelope — the client hands its own instances
 * straight to these handlers — with two deliberate differences: the name is
 * open (above), and the payload stays `unknown` so each router narrows it at
 * the point it actually reads fields, which is what every consumer here
 * already does (`(event.payload ?? {}) as Record<string, unknown>`).
 *
 * `seq` is the field that matters and the reason adopting shared's shape was
 * the enabling change for replay (MJXHRM-530): the backend stamps a
 * per-session monotonic counter on every session-scoped frame, and universal's
 * old local envelope dropped it at the type boundary, so there was nothing for
 * a watermark to be built from.
 */
export interface GatewayEvent<P = unknown> {
  /** Registry connection whose socket delivered the event; absent on the
   *  local/legacy primary path. */
  connectionId?: string
  payload?: P
  /** Renderer-side source tag added by the gateway registry. */
  profile?: string
  /** Per-session monotonic counter (`tui_gateway/event_replay.py::_stamp_event`);
   *  absent on session-less broadcasts. */
  seq?: number
  session_id?: string
  type: GatewayEventName
}
