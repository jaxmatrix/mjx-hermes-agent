import { emitGatewayEvent } from '@/contrib/events'
import { type ConnectionState, type GatewayEvent, JsonRpcGatewayClient, type WebSocketLike } from '@/gateway'
import type { HermesGateway } from '@/hermes'
import { atom } from '@/store/atom'
import { type Connection, resolveWsUrl } from '@/store/gateway-config'
import { TauriWebSocket } from '@/transport/tauri-websocket'

// Whole-stream event listeners. THE session event router registers here (see
// store/event-router.ts, wired from app/contrib/controller.tsx) rather than
// being imported directly, so gateway.ts never statically imports the
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

// Holds the single live gateway client — `@hermes/shared`'s (MJXHRM-530), no
// longer a vendored copy. The ONLY thing universal changes about it is the
// socketFactory: the socket is an IPC-backed TauriWebSocket whose real
// connection lives in Rust (CORS-free). Correlation, timeouts, the heartbeat,
// server→client requests and reconnect replay are the shared client's.

let client: JsonRpcGatewayClient | null = null
/** Which backend the live client belongs to — see {@link targetKey}. */
let clientTarget: null | string = null
/** The newest socket the factory minted, for its transport-level error detail. */
let latestSocket: null | TauriWebSocket = null

/**
 * Read {@link latestSocket} through a call rather than directly.
 *
 * `connectGateway` clears it before dialing, which narrows the binding to
 * `null` for the rest of the function as far as control-flow analysis is
 * concerned — the only write in between happens inside the socketFactory
 * closure, which TS cannot see running. Reading through a function is what
 * keeps the catch block looking at the socket the dial actually minted.
 */
function currentSocket(): null | TauriWebSocket {
  return latestSocket
}

let lastCloseCode: number | undefined

export const $gatewayState = atom<ConnectionState>('idle')

// Compat shim for ported desktop code that reads the live client reactively via
// `useStore($gateway)` (e.g. the Capabilities/MCP tab). Desktop's `$gateway` is
// an atom<HermesGateway | null>; universal keeps the client module-local, so we
// mirror it into this atom on connect/close. The concrete instance is the base
// JsonRpcGatewayClient (HermesGateway adds no members), so the cast is sound.
export const $gateway = atom<HermesGateway | null>(null)

/**
 * Which BACKEND a connection addresses.
 *
 * Only used to decide whether a dial is a reconnect to the same gateway or a
 * move to a different one — see {@link connectGateway}. Mode and profile are
 * part of it because the same baseUrl serves different session namespaces per
 * profile, and a local spawn and a remote URL are different backends even when
 * the address collides on loopback.
 */
function targetKey(conn: Connection): string {
  return `${conn.mode ?? 'remote'}|${conn.baseUrl}|${conn.profile ?? ''}`
}

/** Build the client and wire the listeners that live for its whole lifetime. */
function createClient(): JsonRpcGatewayClient {
  const next = new JsonRpcGatewayClient({
    // Recorded so the reconnect supervisor can tell a REFUSED credential (4401 /
    // 4403) from a dropped connection. The two get different retry budgets, and
    // with the code discarded the supervisor retried a dead credential on the
    // unbounded network ladder. `false` keeps the client's own closed-path
    // running: this callback only observes.
    onSocketClose: event => {
      lastCloseCode = event.code

      return false
    },
    socketFactory: (url: string) => {
      const socket = new TauriWebSocket(url)
      latestSocket = socket

      return socket as unknown as WebSocketLike
    }
  })

  // Wired ONCE per instance, never per dial. The client now outlives a
  // transport drop (see connectGateway), so registering here on every connect
  // would stack a second copy of both listeners per reconnect and fan every
  // event out N times.
  next.onState(state => $gatewayState.set(state))
  next.onAny(event => {
    // Plugins first (contrib/events.ts) — the tap is documented as "before the
    // app's own dispatch", so a plugin observes the raw stream in order and can
    // never be starved by a listener throwing. Listeners there are try/catch
    // isolated and emit is zero-cost when nobody subscribes. `GatewayEvent` is
    // structurally an `RpcEvent` (its `type` union widens to string).
    emitGatewayEvent(event)

    // Then the app's own: one stream, one set of listeners. THE session event
    // router is registered via addGatewayEventListener rather than imported,
    // keeping gateway.ts free of the heavy session-states/profile graph that
    // would reorder module init.
    for (const listener of extraEventListeners) {
      listener(event)
    }
  })

  return next
}

/**
 * Dial `conn`, REUSING the live client when it already belongs to that backend.
 *
 * The reuse is the point, not an optimisation (MJXHRM-530 / G1). The shared
 * client carries the per-session event `seq` watermarks and the backend's
 * `replay_epoch` on the INSTANCE, and `close()`/`invalidate()` deliberately
 * keep them — they are what `session.events.since` needs on the next open to
 * ask for exactly the frames the drop ate. Constructing a fresh client per dial
 * (which is what this function used to do) throws that state away, so every
 * reconnect starts with an empty watermark map and the replay fetch
 * short-circuits on `lastSeenSeq.size === 0`. The failure is silent: replay
 * simply never runs, and unit tests that do not simulate a real drop still pass.
 *
 * A dial to a DIFFERENT backend does rebuild, and must: seq numbering is
 * per-backend, so carrying watermarks across a gateway switch would ask the new
 * backend to replay from a position in someone else's numbering.
 */
export async function connectGateway(conn: Connection): Promise<void> {
  const target = targetKey(conn)

  if (client && clientTarget !== target) {
    client.close()
    client = null
    clientTarget = null
  }

  if (client) {
    // Same backend: drop the dead socket generation but KEEP the replay state.
    client.close()
  } else {
    client = createClient()
    $gateway.set(client as HermesGateway)
  }

  clientTarget = target
  latestSocket = null

  // Mint the ticket BEFORE constructing the socket so a stale one is never used.
  // resolveWsUrl (store/gateway-config) handles none/token/ticket/oauth; oauth
  // raises GatewayReauthRequiredError when the session is dead.
  const wsUrl = await resolveWsUrl(conn)

  try {
    await client.connect(wsUrl)
  } catch (error) {
    // The shared client rejects with a generic "WebSocket connection failed" —
    // it is written against a browser WebSocket, whose error event carries no
    // detail. Ours does: the real socket is in Rust, so tungstenite's reason
    // ("HTTP error: 403", a TLS failure) reached the façade. Surface it, or the
    // connect screen loses the only text that says WHY the dial failed.
    const detail = currentSocket()?.lastErrorDetail

    throw detail ? new Error(detail) : error
  }
}

/**
 * The close code of the last gateway socket, when the server sent one.
 *
 * The supervisor needs it to tell 4401/4403 (refused credential — bounded, then
 * stop) from a dropped connection (retry indefinitely). Read after the close, so
 * it deliberately survives the socket.
 */
export function lastGatewayCloseCode(): number | undefined {
  return lastCloseCode
}

/**
 * Tear the gateway down for good.
 *
 * Unlike the reconnect path above this DROPS the client, and with it the replay
 * watermarks — correct, because every caller (disconnect, sign-out, a soft
 * switch onto another gateway) is leaving this backend, and a watermark only
 * means anything against the numbering that produced it.
 */
export function closeGateway(): void {
  client?.close()
  client = null
  clientTarget = null
  latestSocket = null
  $gateway.set(null)
  $gatewayState.set('closed')
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

// The live gateway client, typed as HermesGateway for the ported composer
// completion hooks (use-at-completions / use-slash-completions) which take a
// `gateway` prop and only ever call `gateway.request(method, params)`. The
// concrete instance is a base JsonRpcGatewayClient (HermesGateway adds no
// members), so the cast is sound; the socket underneath is the Tauri IPC one.
// Returns null until connected.
export function getGatewayClient(): HermesGateway | null {
  return client as HermesGateway | null
}

// Subscribe to a single server-push event type (e.g. streaming progress events
// that don't flow through the chat reducer). Returns an unsubscribe fn; a no-op
// when no client is live. Used by the pet-generate flow (pet.*.progress).
//
// The cast is the one place universal widens the shared client's event map:
// `on` is keyed on the generated `GatewayEventName` union, and these callers
// pass names that ARE in that union (pet.generate.progress,
// billing.step_up.verification) but arrive here as a bare `string`. Casting at
// this single seam keeps the widening out of apps/shared.
export function subscribeGateway<P = unknown>(type: string, handler: (payload: P) => void): () => void {
  if (!client) {
    return () => {}
  }

  return client.on(type as Parameters<JsonRpcGatewayClient['on']>[0], event => handler(event.payload as P))
}
