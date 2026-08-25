import { invoke } from '@tauri-apps/api/core'

import { type GatewayEvent, JsonRpcGatewayClient, type WebSocketLike } from '@/gateway'
import { TauriWebSocket } from '@/transport/tauri-websocket'

/**
 * REQUEST-ONLY sockets to sources that are not the active one.
 *
 * Rule 21 says "one gateway socket per WebView, and every window is a WebView".
 * That rule is about the CHAT STREAM: one live client per window owning the
 * session events, so anything global has to broadcast. It is not a prohibition
 * on a second socket — `transport.rs` has held a `HashMap<String, SocketHandle>`
 * keyed by a JS-chosen id since Step 2a, and `ws_open` already takes that id.
 *
 * What makes these safe is what they are NOT:
 *
 *  • they never become `getGatewayClient()` / `$gateway`. A plugin holding one
 *    would keep a socket alive past its reap, and the session stores would start
 *    receiving events for ids they have never seen;
 *  • every event is stamped with its `connectionId` and offered to
 *    `addConnectionEventListener`. Anything unclaimed is DROPPED (rule 7) — a
 *    foreign session id must not reach `$sessionStates` by accident;
 *  • Rust never reconnects them (rule 6) and neither does this: a dropped
 *    secondary is re-opened by the next lease. A background retry ladder against
 *    four gateways is how you exhaust a gateway's descriptors.
 *
 * Bounded at {@link MAX_SECONDARIES} live with a {@link IDLE_REAP_MS} idle reap.
 */

/**
 * Live secondaries.
 *
 * FIVE, not the four the design first proposed. Reconciliation A11: a Bot Mode
 * room (MJXHRM-445) with six members spread over six profiles of one connection
 * needs five distinct scope leases, because `dispatch` short-circuits only on
 * the ACTIVE scope. A cap of four would LRU-evict a member mid-round, which
 * reads as one bot silently going quiet. Five is that worst case exactly; a
 * sixth is the point at which serialising is the right answer, not a bigger map.
 */
export const MAX_SECONDARIES = 5
/** No in-flight request for this long and the socket is pure cost. */
export const IDLE_REAP_MS = 60_000

export interface SecondaryLease {
  scopeKey: string
  connectionId: string
  request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

interface Secondary {
  scopeKey: string
  connectionId: string
  client: JsonRpcGatewayClient
  inFlight: number
  lastUsed: number
  reaper: null | ReturnType<typeof setTimeout>
}

const live = new Map<string, Secondary>()
const listeners = new Map<string, Set<(event: GatewayEvent) => void>>()

/**
 * Hear one source's events.
 *
 * A registration hook, the house shape (`addGatewayEventListener`,
 * `setStreamBatchSink`, `addSessionKeyHooks`), returning an idempotent
 * unregister. It exists because a secondary's events have to go SOMEWHERE and
 * rule 7 says the default is nowhere.
 */
export function addConnectionEventListener(
  connectionId: string,
  handler: (event: GatewayEvent) => void
): () => void {
  const held = listeners.get(connectionId) ?? new Set()

  held.add(handler)
  listeners.set(connectionId, held)

  return () => {
    held.delete(handler)

    if (held.size === 0) {
      listeners.delete(connectionId)
    }
  }
}

function deliver(connectionId: string, event: GatewayEvent): void {
  const held = listeners.get(connectionId)

  if (!held?.size) {
    // DROPPED, deliberately. The alternative — handing it to the app's own
    // router — would put another machine's session id into the active
    // connection's stores.
    return
  }

  for (const handler of held) {
    try {
      handler({ ...event, connectionId } as GatewayEvent)
    } catch {
      // One bad listener must not starve the others.
    }
  }
}

function armReap(secondary: Secondary): void {
  if (secondary.reaper) {
    clearTimeout(secondary.reaper)
  }

  secondary.reaper = setTimeout(() => {
    if (secondary.inFlight === 0) {
      close(secondary)
    }
  }, IDLE_REAP_MS)
}

function close(secondary: Secondary): void {
  if (secondary.reaper) {
    clearTimeout(secondary.reaper)
  }

  live.delete(secondary.scopeKey)
  secondary.client.close()
}

function evictLeastRecentlyUsed(): void {
  let oldest: Secondary | null = null

  for (const secondary of live.values()) {
    // An in-flight request is never the victim: evicting it would reject a call
    // the caller is already awaiting.
    if (secondary.inFlight > 0) {
      continue
    }

    if (!oldest || secondary.lastUsed < oldest.lastUsed) {
      oldest = secondary
    }
  }

  if (oldest) {
    close(oldest)
  }
}

/**
 * Open (or reuse) the socket for a scope.
 *
 * `connections_resolve` answers where the scope lives and whether Rust holds a
 * credential for it; the token itself is appended by `ws_open` in Rust, so it
 * never enters JS.
 */
export async function leaseSecondary(scopeKey: string, connectionId: string): Promise<SecondaryLease> {
  const existing = live.get(scopeKey)

  if (existing) {
    existing.lastUsed = Date.now()

    return leaseFor(existing)
  }

  if (live.size >= MAX_SECONDARIES) {
    evictLeastRecentlyUsed()
  }

  const resolved = await invoke<{ baseUrl?: string; dialConnectionId?: string; profile?: string }>(
    'connections_resolve',
    { connectionId, profile: null }
  )

  if (!resolved.baseUrl) {
    // `local` and `ssh` are reached by CONNECTING to them; there is no address a
    // second socket could dial from a descriptor alone.
    throw new Error(`no addressable gateway for ${connectionId}`)
  }

  const client = new JsonRpcGatewayClient({
    socketFactory: (url: string) => new TauriWebSocket(url, { connectionId }) as unknown as WebSocketLike
  })

  const secondary: Secondary = {
    client,
    connectionId,
    inFlight: 0,
    lastUsed: Date.now(),
    reaper: null,
    scopeKey
  }

  client.onAny(event => deliver(connectionId, event))
  live.set(scopeKey, secondary)

  const wsUrl = `${resolved.baseUrl.replace(/^http/, 'ws')}/api/ws`

  try {
    await client.connect(wsUrl)
  } catch (error) {
    close(secondary)

    throw error
  }

  armReap(secondary)

  return leaseFor(secondary)
}

function leaseFor(secondary: Secondary): SecondaryLease {
  return {
    connectionId: secondary.connectionId,
    async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
      secondary.inFlight += 1

      try {
        return await secondary.client.request<T>(method, params, timeoutMs)
      } finally {
        secondary.inFlight -= 1
        secondary.lastUsed = Date.now()
        armReap(secondary)
      }
    },
    scopeKey: secondary.scopeKey
  }
}

/** Release a lease. The socket is kept for the idle window, then reaped. */
export function releaseSecondary(lease: SecondaryLease): void {
  const secondary = live.get(lease.scopeKey)

  if (secondary && secondary.inFlight === 0) {
    armReap(secondary)
  }
}

/**
 * Drop every secondary.
 *
 * Called from `wipeSessionListsForGatewaySwitch()` (rule 20's one wipe list):
 * these sockets belong to the source we are LEAVING, and a credential attached
 * per base URL in Rust has just been re-pointed.
 */
export function closeAllSecondaries(): void {
  for (const secondary of [...live.values()]) {
    close(secondary)
  }
}

export const __testing = {
  liveScopeKeys: (): string[] => [...live.keys()],
  reset: (): void => {
    closeAllSecondaries()
    listeners.clear()
  }
}
