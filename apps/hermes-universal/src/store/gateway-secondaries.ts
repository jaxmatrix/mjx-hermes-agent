import { invoke } from '@tauri-apps/api/core'

import { type GatewayEvent, JsonRpcGatewayClient, type WebSocketLike } from '@/gateway'
import { acquireTunnel, type TunnelLease } from '@/store/connection-tunnels'
import { SessionRouteError } from '@/store/session-route-dispatch'
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
  /** A tab is streaming on this socket (MJXHRM-591). A pinned secondary is the
   *  connection's OWNING client: exempt from the LRU cap and from the idle reap,
   *  and kept across a gateway switch. Unpinned on the last tab's close, which
   *  DEMOTES it to an ordinary request-only secondary rather than closing it —
   *  the existing idle window then makes a reopen inside a minute warm. */
  pinned: boolean
  connectionId: string
  client: JsonRpcGatewayClient
  inFlight: number
  lastUsed: number
  reaper: null | ReturnType<typeof setTimeout>
  /** Held for the secondary's life when the source is local or SSH (MJXHRM-592). */
  tunnel: null | TunnelLease
  /** Undoes the tunnel subscriptions `close` must not leave behind. */
  unsubscribe: (() => void)[]
  /** The tunnel moved or closed while the socket was still opening. */
  stale: boolean
}

const live = new Map<string, Secondary>()
/** Opens in flight, so concurrent leases on one scope share one open — only
 *  while no switch has invalidated it (its revision is still current). */
const opening = new Map<string, { promise: Promise<Secondary>; revision: number }>()
/** Bumped by `closeAllSecondaries`: an open that began before it is stale. */
let openRevision = 0
/** The newest switch that has settled: nothing it closed stays parked. */
let settledRevision = 0
const listeners = new Map<string, Set<(event: GatewayEvent) => void>>()
/**
 * Told when a PINNED socket goes away — its tunnel moved or closed, a hard stop,
 * a quit (MJXHRM-591).
 *
 * Rule 6 stands: this module still never reconnects anything. It only reports,
 * because the tabs streaming on that socket are the reason to try again, and
 * they are not this module's to know about.
 */
let onPinnedClosed: ((scopeKey: string, connectionId: string) => void) | null = null

export function setPinnedSecondaryClosedListener(handler: (scopeKey: string, connectionId: string) => void): void {
  onPinnedClosed = handler
}

/** Scopes some tab is streaming on. Held here rather than on the `Secondary`
 *  alone, so a pin taken while the socket is still opening survives the open. */
const pinnedScopes = new Set<string>()

/** How many live sockets the {@link MAX_SECONDARIES} cap governs. */
function requestOnlyCount(): number {
  let count = 0

  for (const secondary of live.values()) {
    if (!secondary.pinned) {
      count += 1
    }
  }

  return count
}

/**
 * This scope now carries a tab's live stream: never evicted, never idle-reaped,
 * and kept across a gateway switch (MJXHRM-591, invariants 32-34).
 */
export function pinSecondary(scopeKey: string): void {
  pinnedScopes.add(scopeKey)

  const secondary = live.get(scopeKey)

  if (secondary) {
    secondary.pinned = true

    if (secondary.reaper) {
      clearTimeout(secondary.reaper)
      secondary.reaper = null
    }
  }
}

/**
 * The last tab on this scope closed: DEMOTE, do not close. The socket becomes an
 * ordinary request-only secondary and leaves on the existing idle reap, so a
 * reopen inside that window is warm and a slower one pays for a fresh dial.
 */
export function unpinSecondary(scopeKey: string): void {
  pinnedScopes.delete(scopeKey)

  const secondary = live.get(scopeKey)

  if (secondary?.pinned) {
    secondary.pinned = false
    armReap(secondary)
  }
}

/**
 * Hear one source's events.
 *
 * A registration hook, the house shape (`addGatewayEventListener`,
 * `setStreamBatchSink`, `addSessionKeyHooks`), returning an idempotent
 * unregister. It exists because a secondary's events have to go SOMEWHERE and
 * rule 7 says the default is nowhere.
 */
export function addConnectionEventListener(connectionId: string, handler: (event: GatewayEvent) => void): () => void {
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
    secondary.reaper = null
  }

  // A hold never ages out. Evicting a socket a visible tab is streaming on is
  // the failure this module's header already warns about, one rung worse.
  if (secondary.pinned) {
    return
  }

  secondary.reaper = setTimeout(() => {
    if (secondary.inFlight === 0) {
      close(secondary)
    }
  }, IDLE_REAP_MS)
}

/** Tunnel holds kept across a gateway switch, tagged with that switch's revision. */
const parked: { revision: number; tunnel: TunnelLease }[] = []

/**
 * Keep a hold a switch closed until that switch settles — unless it already
 * has, in which case nothing would ever release it.
 */
function park(tunnel: TunnelLease, revision: number): void {
  if (settledRevision < revision) {
    parked.push({ revision, tunnel })
  } else {
    tunnel.release()
  }
}

/** `parkAt`: the revision of the switch that closed it, when a switch did. */
function close(secondary: Secondary, parkAt?: number): void {
  if (secondary.reaper) {
    clearTimeout(secondary.reaper)
    secondary.reaper = null
  }

  for (const off of secondary.unsubscribe.splice(0)) {
    off()
  }

  // Only this secondary's own entry: a replacement may already sit at the key.
  if (live.get(secondary.scopeKey) === secondary) {
    live.delete(secondary.scopeKey)
  }

  secondary.client.close()

  if (secondary.pinned) {
    // Reported AFTER the socket is down and out of `live`, so a listener that
    // re-leases sees the real state rather than the one being dismantled.
    try {
      onPinnedClosed?.(secondary.scopeKey, secondary.connectionId)
    } catch {
      // A listener must not break a teardown.
    }
  }

  if (parkAt !== undefined && secondary.tunnel) {
    park(secondary.tunnel, parkAt)
  } else {
    secondary.tunnel?.release()
  }

  secondary.tunnel = null
}

function evictLeastRecentlyUsed(): void {
  let oldest: Secondary | null = null

  for (const secondary of live.values()) {
    // An in-flight request is never the victim: evicting it would reject a call
    // the caller is already awaiting. Neither is a PINNED one: it is some tab's
    // live stream, and the cap counts request-only sockets.
    if (secondary.inFlight > 0 || secondary.pinned) {
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
 *
 * Single-flight per scope (MJXHRM-592): a second lease while the first is
 * still opening — a cold SSH dial takes 45–90 s — shares that open instead of
 * starting its own and overwriting the first. Upstream's in-flight-by-key shape
 * (`apps/desktop/src/store/managed-updates.ts`). An open a switch has since
 * invalidated is never shared: it can only end in `switching`, so a lease after
 * the switch starts its own (upstream `backend-connection-state.ts`).
 */
export async function leaseSecondary(scopeKey: string, connectionId: string): Promise<SecondaryLease> {
  const existing = live.get(scopeKey)

  if (existing) {
    existing.lastUsed = Date.now()

    return leaseFor(existing)
  }

  const pending = opening.get(scopeKey)
  let open = pending?.revision === openRevision ? pending.promise : null

  if (!open) {
    const started = openSecondary(scopeKey, connectionId, openRevision).finally(() => {
      // Only this open's entry: a later open may already sit at the key.
      if (opening.get(scopeKey)?.promise === started) {
        opening.delete(scopeKey)
      }
    })

    opening.set(scopeKey, { promise: started, revision: openRevision })
    open = started
  }

  const secondary = await open

  secondary.lastUsed = Date.now()

  return leaseFor(secondary)
}

async function openSecondary(scopeKey: string, connectionId: string, revision: number): Promise<Secondary> {
  // A switch during the open: whatever it built goes, and the caller hears the
  // same answer a routed request gets mid-switch.
  const switched = () => revision !== openRevision

  // The cap counts REQUEST-ONLY sockets: owning clients are bounded by
  // "connections with at least one open tab", which the user chose.
  if (requestOnlyCount() >= MAX_SECONDARIES) {
    evictLeastRecentlyUsed()
  }

  const resolved = await invoke<{
    baseUrl?: string
    dialConnectionId?: string
    kind?: string
    label?: string
    profile?: string
  }>('connections_resolve', { connectionId, profile: null })

  if (switched()) {
    throw new SessionRouteError('switching', scopeKey)
  }

  // `local` and `ssh` have no address of their own: they are reached through a
  // tunnel Rust holds for as long as this secondary does.
  const tunnel =
    !resolved.baseUrl && (resolved.kind === 'local' || resolved.kind === 'ssh')
      ? await acquireTunnel(connectionId, { label: resolved.label })
      : null

  if (switched()) {
    if (tunnel) {
      park(tunnel, openRevision)
    }

    throw new SessionRouteError('switching', scopeKey)
  }

  const baseUrl = resolved.baseUrl ?? tunnel?.baseUrl()

  if (!baseUrl) {
    tunnel?.release()

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
    pinned: pinnedScopes.has(scopeKey),
    reaper: null,
    scopeKey,
    stale: false,
    tunnel,
    unsubscribe: []
  }

  // A secondary still opening is not in `live`: it is marked, and the open
  // closes it once `connect` settles.
  const invalidate = () => {
    if (live.get(scopeKey) === secondary) {
      close(secondary)
    } else {
      secondary.stale = true
    }
  }

  client.onAny(event => deliver(connectionId, event))

  if (tunnel) {
    const dialled = tunnel.generation()

    secondary.unsubscribe.push(
      // A redial moved the tunnel to a new port: this socket is dead weight, and
      // the next request opens a fresh one against the new base. Only a LATER
      // generation: the event for the dial this socket rides can land after it.
      tunnel.onChange(next => {
        if (next.generation > dialled) {
          invalidate()
        }
      }),
      // The tunnel no longer serves us (closed, forgotten, needs sign-in): a
      // socket kept in `live` would be handed to every later request.
      tunnel.onClosed(invalidate)
    )
  }

  const wsUrl = tunnel ? tunnel.wsUrl() : `${baseUrl.replace(/^http/, 'ws')}/api/ws`

  try {
    await client.connect(wsUrl)
  } catch (error) {
    // Releases the tunnel once, for every caller sharing this open.
    close(secondary)

    throw error
  }

  if (switched() || secondary.stale) {
    // Parked only when a switch caused it, as `closeAllSecondaries` parks.
    close(secondary, switched() ? openRevision : undefined)

    throw new SessionRouteError('switching', scopeKey)
  }

  // Only now can a lease reach it: never a half-open secondary.
  live.set(scopeKey, secondary)
  armReap(secondary)

  return secondary
}

function leaseFor(secondary: Secondary): SecondaryLease {
  return {
    connectionId: secondary.connectionId,
    async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
      // A lease on a closed secondary must not reach its dead socket, nor re-arm
      // a reap timer for a secondary nothing tracks any more.
      if (live.get(secondary.scopeKey) !== secondary) {
        throw new Error(`secondary for ${secondary.connectionId} is closed`)
      }

      secondary.inFlight += 1

      try {
        return await secondary.client.request<T>(method, params, timeoutMs)
      } finally {
        secondary.inFlight -= 1
        secondary.lastUsed = Date.now()

        if (live.get(secondary.scopeKey) === secondary) {
          armReap(secondary)
        }
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
export function closeAllSecondaries(): number {
  // Opens still in flight belong to the source being left too.
  openRevision += 1

  const revision = openRevision

  for (const secondary of [...live.values()]) {
    // A PINNED socket is a connection's owning client: tabs are streaming on it,
    // and a switch touches only what it leaves (invariant 37). It keeps its
    // tunnel hold too, so nothing is parked for it and 592's invariant 13 is
    // unaffected.
    if (secondary.pinned) {
      continue
    }

    // The tunnel hold outlives the socket until the switch settles: switching
    // ONTO a connection a secondary was riding must adopt its tunnel, not watch
    // it torn down a moment before the new dial (MJXHRM-592).
    close(secondary, revision)
  }

  return revision
}

/**
 * The switch that began at `revision` settled: let go of every hold parked by
 * it or an earlier switch, and park nothing it closed from here on. A newer
 * switch still in flight keeps its own.
 */
export function releaseParkedTunnels(revision: number): void {
  settledRevision = Math.max(settledRevision, revision)

  for (let index = parked.length - 1; index >= 0; index -= 1) {
    const entry = parked[index]

    if (entry && entry.revision <= revision) {
      parked.splice(index, 1)
      entry.tunnel.release()
    }
  }
}

export const __testing = {
  /** Take a pinned socket away, as a tunnel move or a host asleep does. */
  closePinned: (scopeKey: string): void => {
    const secondary = live.get(scopeKey)

    if (secondary) {
      close(secondary)
    }
  },
  isPinned: (scopeKey: string): boolean => Boolean(live.get(scopeKey)?.pinned),
  liveScopeKeys: (): string[] => [...live.keys()],
  openingCount: (): number => opening.size,
  parkedCount: (): number => parked.length,
  /**
   * Every module map back to empty. The revisions end settled (settled = open),
   * as on a fresh load, but never go back to 0: an open a previous test left
   * pending captured an old revision, and must still see that it was switched.
   */
  reset: (): void => {
    onPinnedClosed = null
    pinnedScopes.clear()

    for (const secondary of live.values()) {
      secondary.pinned = false
    }

    releaseParkedTunnels(closeAllSecondaries())
    opening.clear()
    listeners.clear()
  }
}
