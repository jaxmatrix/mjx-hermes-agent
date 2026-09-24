/**
 * Universal's JSON-RPC gateway CLIENT — the wire layer. It owns the one live
 * socket: connect/close, the request path, the whole-stream event tap and the
 * active-profile stamp every RPC carries. The client is the reused
 * `JsonRpcGatewayClient` (vendored from apps/shared); the ONLY difference from
 * the desktop's is the socketFactory, which hands it an IPC-backed
 * `TauriWebSocket` whose real connection lives in Rust (CORS-free).
 *
 * Separate from `store/gateway.ts` on purpose. That file is DESKTOP's gateway
 * REGISTRY — the primary/secondary multiplexer keyed by profile, agent and
 * connection (`setPrimaryGateway`, `ensureGatewayForProfile`,
 * `requestGatewayForAgent`, the secondary pool) — and is kept byte-identical to
 * `apps/desktop/src/store/gateway.ts` so every future resync of it is mechanical
 * (an AUTO file for `scripts/desktop-sync.mjs`, not a hand-merge). The two
 * modules only ever shared a filename: a registry needs a client to multiplex,
 * it is not one.
 *
 * `$gateway` is NOT declared here any more. It used to be a compat shim
 * mirroring the module-local client into an atom for ported desktop components
 * that read `useStore($gateway)`; the real atom is desktop's, in `./gateway`,
 * published by the registry's `setPrimaryGateway`. Two atoms for one concept is
 * a bug, so the shim is gone rather than duplicated — this module must also stay
 * free of a static import of `./gateway`, which would drag the session graph in
 * (see the TDZ note below).
 */
import { emitGatewayEvent } from '@/contrib/events'
import { type GatewayEvent, JsonRpcGatewayClient, type WebSocketLike } from '@/gateway'
import type { HermesGateway } from '@/hermes'
import { type Connection, resolveWsUrl } from '@/store/gateway-config'
import { setGatewayState } from '@/store/session'
import { TauriWebSocket } from '@/transport/tauri-websocket'

// Whole-stream event listeners. THE session event router registers here (see
// store/event-router.ts, wired from app/contrib/controller.tsx) rather than
// being imported directly, so this module never statically imports the
// session-states/profile graph — a static import reorders module init and trips
// the `@/hermes` `_apiProfile` TDZ cycle in tests.
const extraEventListeners = new Set<(event: GatewayEvent) => void>()

/** Add a whole-stream gateway event listener. Returns a disposer. */
export function addGatewayEventListener(listener: (event: GatewayEvent) => void): () => void {
  extraEventListeners.add(listener)

  return () => {
    extraEventListeners.delete(listener)
  }
}

// Holds the single live gateway client. Correlation/timeout/reconnect logic is
// unchanged from the shared client.

let client: JsonRpcGatewayClient | null = null

// Re-exported, not redeclared. Desktop's store/session.ts owns the atom and its
// setter, and store/session.ts is byte-identical to desktop's so it cannot be
// changed. Declaring a second atom of the same name here left 29 files reading
// desktop's — which nothing in universal ever writes, so they would have shown
// "disconnected" forever — while 17 read this one. Same bug class as `$gateway`,
// but the opposite resolution: this client IS what connects in universal, so it
// must write through to the atom the ported components read.
//
// Safe to import: desktop's session.ts value-imports neither @/hermes nor the
// gateway, so this edge does not close the _apiProfile TDZ cycle.
export { $gatewayState } from '@/store/session'

export async function connectGateway(conn: Connection): Promise<void> {
  client?.close()

  // Mint the ticket BEFORE constructing the socket so a stale one is never used.
  // resolveWsUrl (store/gateway-config) handles none/token/ticket/oauth; oauth
  // raises GatewayReauthRequiredError when the session is dead.
  const wsUrl = await resolveWsUrl(conn)

  const next = new ProfiledGatewayClient({
    socketFactory: (url: string) => new TauriWebSocket(url) as unknown as WebSocketLike
  })

  next.onState(state => setGatewayState(state))
  next.onAny(event => {
    // Plugins first (contrib/events.ts) — the tap is documented as "before the
    // app's own dispatch", so a plugin observes the raw stream in order and can
    // never be starved by a listener throwing. Listeners there are try/catch
    // isolated and emit is zero-cost when nobody subscribes. `GatewayEvent` is
    // structurally an `RpcEvent` (its `type` union widens to string).
    emitGatewayEvent(event as Parameters<typeof emitGatewayEvent>[0])

    // Then the app's own: one stream, one set of listeners. THE session event
    // router is registered via addGatewayEventListener rather than imported,
    // keeping this module free of the heavy session-states/profile graph that
    // would reorder module init.
    for (const listener of extraEventListeners) {
      listener(event)
    }
  })
  client = next

  await next.connect(wsUrl)
}

/**
 * The close code of the last gateway socket, when the server sent one.
 *
 * The supervisor needs it to tell 4401/4403 (refused credential — bounded, then
 * stop) from a dropped connection (retry indefinitely). Read after the close, so
 * it deliberately survives the socket.
 */
export function lastGatewayCloseCode(): number | undefined {
  return client?.lastCloseCode
}

export function closeGateway(): void {
  client?.close()
  client = null
  setGatewayState('closed')
}

export function requestGateway<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<T> {
  if (!client) {
    return Promise.reject(new Error('Hermes gateway is not connected'))
  }

  return client.request<T>(method, params, timeoutMs)
}

type GatewayProfileResolver = () => null | string

let gatewayProfile: GatewayProfileResolver = () => null

/**
 * Where the active, non-default profile comes from. A registration hook, like
 * `setSessionRequestRouter`, so this module never imports the profile graph;
 * `store/connection-session-router.ts` registers it.
 */
export function setGatewayRequestProfile(resolver: GatewayProfileResolver): () => void {
  const previous = gatewayProfile

  gatewayProfile = resolver

  return () => {
    if (gatewayProfile === resolver) {
      gatewayProfile = previous
    }
  }
}

/**
 * Name the active profile on an RPC that names none (MJXHRM-592).
 *
 * Local and SSH backends run the backend's unified server, and an RPC without
 * `profile` runs against its launch profile (`tui_gateway/server.py`), which is
 * `default`. REST already carries the active profile (`hermes.ts`
 * `apiRequestProfile`); this is the same rule for the socket, and the one the
 * session router applies to a same-connection route. A caller that set
 * `profile` keeps it, and `profiles.*` methods are left alone: their profile is
 * the target (`profiles.*` is keyed by `name`), not the scope.
 */
export function withGatewayProfile(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const profile = gatewayProfile()

  if (!profile || method.startsWith('profiles.') || Object.hasOwn(params, 'profile')) {
    return params
  }

  return { ...params, profile }
}

// The live gateway client, typed as HermesGateway for the ported composer
// completion hooks (use-at-completions / use-slash-completions) which take a
// `gateway` prop and only ever call `gateway.request(method, params)`. The
// concrete instance is a base JsonRpcGatewayClient (HermesGateway adds no
// members), so the cast is sound; the socket underneath is the Tauri IPC one.
// Returns null until connected.
/**
 * The primary client (MJXHRM-592). Every call made on it — `requestGateway`,
 * `getGatewayClient()` and the SDK's `getGateway` alike (`model.options`,
 * `commands.catalog`, `complete.*`, `llm.oneshot`, `reload.mcp`) — names the
 * active profile when it names none. A subclass rather than a wrapper at one
 * call site, so no caller can reach the socket around it.
 */
class ProfiledGatewayClient extends JsonRpcGatewayClient {
  override request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<T> {
    return super.request<T>(method, withGatewayProfile(method, params), timeoutMs, signal)
  }
}

export function getGatewayClient(): HermesGateway | null {
  return client as HermesGateway | null
}

// Subscribe to a single server-push event type (e.g. streaming progress events
// that don't flow through the chat reducer). Returns an unsubscribe fn; a no-op
// when no client is live. Used by the pet-generate flow (pet.*.progress).
export function subscribeGateway<P = unknown>(type: string, handler: (payload: P) => void): () => void {
  if (!client) {
    return () => {}
  }

  return client.on<P>(type, event => handler(event.payload as P))
}
