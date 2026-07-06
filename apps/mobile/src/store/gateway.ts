import { type ConnectionState, JsonRpcGatewayClient, type WebSocketLike, buildHermesWebSocketUrl } from '@/gateway'
import { mintWsTicket } from '@/lib/auth'
import { handleGatewayEvent } from '@/store/chat'
import type { Connection } from '@/store/connection'
import { atom } from '@/store/atom'
import { TauriWebSocket } from '@/transport/tauri-websocket'

// Holds the single live gateway client. The client itself is the reused
// JsonRpcGatewayClient (vendored from apps/shared) — the ONLY change vs the
// desktop is the socketFactory: the socket is an IPC-backed TauriWebSocket whose
// real connection lives in Rust (CORS-free). Correlation/timeout/reconnect logic
// is unchanged.

let client: JsonRpcGatewayClient | null = null

export const $gatewayState = atom<ConnectionState>('idle')

// Build the WS URL for a connect. Gated backends need a FRESH single-use ticket
// (30s TTL), minted here per connect via the cookie held in Rust; token/none
// backends use the static ?token= (or nothing).
async function wsUrlFor(conn: Connection): Promise<string> {
  const u = new URL(conn.baseUrl)
  let authParam: readonly [string, string] | undefined
  if (conn.authMode === 'ticket') {
    authParam = ['ticket', await mintWsTicket(conn.baseUrl)]
  } else if (conn.authMode === 'token' && conn.token) {
    authParam = ['token', conn.token]
  }
  return buildHermesWebSocketUrl({
    protocol: u.protocol,
    host: u.host,
    path: '/api/ws',
    authParam
  })
}

export async function connectGateway(conn: Connection): Promise<void> {
  client?.close()

  // Mint the ticket BEFORE constructing the socket so a stale one is never used.
  const wsUrl = await wsUrlFor(conn)

  const next = new JsonRpcGatewayClient({
    socketFactory: (url: string) => new TauriWebSocket(url) as unknown as WebSocketLike
  })
  next.onState(state => $gatewayState.set(state))
  next.onAny(event => handleGatewayEvent(event))
  client = next

  await next.connect(wsUrl)
}

export function closeGateway(): void {
  client?.close()
  client = null
  $gatewayState.set('closed')
}

export function requestGateway<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<T> {
  if (!client) return Promise.reject(new Error('Hermes gateway is not connected'))
  return client.request<T>(method, params, timeoutMs)
}
