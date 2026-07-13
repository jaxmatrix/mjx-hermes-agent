// VENDORED from apps/shared/src (the app is not a pnpm workspace, so a
// `@hermes/shared` dependency can't be resolved by the Android build's package
// manager). Keep in sync with apps/shared if that gateway client changes.
export {
  JsonRpcGatewayClient,
  type ConnectionState,
  type GatewayClientOptions,
  type GatewayEvent,
  type GatewayEventName,
  type GatewayRequestId,
  type JsonRpcFrame,
  type WebSocketLike
} from './json-rpc-gateway'
export {
  GatewayReauthRequiredError,
  buildHermesWebSocketUrl,
  isGatewayReauthRequired,
  resolveGatewayWsUrl,
  type GatewayAuthMode,
  type GatewayWsConnection,
  type HermesWebSocketUrlOptions,
  type ResolveGatewayWsUrlDeps,
  type WebSocketAuthParam
} from './websocket-url'
