/**
 * OWNING CLIENTS — one socket per connection, owned by the tabs bound to it
 * (MJXHRM-591).
 *
 * A tab bound to a background connection has to stream, not just ask questions,
 * and `gateway-secondaries` was built for the opposite case: request-only
 * sockets, capped at five, reaped after a minute idle, with every event dropped
 * because nothing listens. This module is the other half of that machine rather
 * than a second one — it PINS a scope (exempt from the cap and the reap, kept
 * across a switch) and registers the listener that carries its frames into the
 * ordinary event router, scoped by the connection that delivered them.
 *
 * The rules, and why:
 *
 *  * ONE socket per connection (invariant 32). `clientFor` answers `ambient` for
 *    the active connection, so a tab there opens nothing — the app already holds
 *    that socket, and a second one would double every frame.
 *  * PINNED means never evicted and never reaped (invariant 33). Evicting the
 *    socket a visible tab streams on is the failure `gateway-secondaries`'
 *    header warns about, one rung worse; the cap goes on governing request-only
 *    sockets, and owning clients are bounded by "connections with an open tab".
 *  * The LAST tab closing DEMOTES, it does not kill (invariant 34). The socket
 *    becomes request-only and leaves on the existing 60 s idle reap, so
 *    reopening a tab inside that window is warm. An immediate close is only for
 *    a connection that was removed or edited, and for quit.
 *
 * Refcounted by TAB, not by request: `hold`/`release` are the two verbs, and a
 * connection with one tab open holds one socket however many requests ride it.
 */

import type { GatewayEvent } from '@/gateway'
import { backendScopeKey } from '@/lib/backend-scope'
import { $activeConnection } from '@/store/active-connection'
import { addConnectionEventListener, leaseSecondary, pinSecondary, unpinSecondary } from '@/store/gateway-secondaries'
import { normalizeProfileKey } from '@/store/profile'

/** What a tab's work goes through. */
export type ConnectionClient =
  /** The app's own socket: the tab is on the active connection. */
  | { kind: 'ambient' }
  /** This connection's own socket, held for as long as a tab needs it. */
  | { kind: 'owning'; connectionId: string; scopeKey: string }

interface Hold {
  connectionId: string
  scopeKey: string
  /** Open tabs bound to this connection. The socket lives while it is > 0. */
  tabs: number
  /** Undoes the event listener, so a demoted client stops routing frames. */
  unlisten: null | (() => void)
  /** The open in flight, if any — so two tabs binding at once share it. */
  opening: null | Promise<void>
}

const holds = new Map<string, Hold>()

/** How a frame from a connection's own socket reaches the app. Registered by the
 *  owning client alone: `deliver()` drops anything nobody claims (rule 7). */
let sink: ((event: GatewayEvent) => void) | null = null

export function setConnectionEventSink(next: (event: GatewayEvent) => void): void {
  sink = next
}

const scopeOf = (connectionId: string, profile: null | string | undefined): string =>
  backendScopeKey(connectionId, normalizeProfileKey(profile ?? 'default'))

/** Whether `connectionId` is the one the app itself is pointed at. */
export function isAmbientConnection(connectionId: string): boolean {
  return $activeConnection.get()?.connectionId === connectionId
}

/**
 * The client a tab on `connectionId` works through.
 *
 * A tab on the ACTIVE connection opens nothing: `ambient` names the socket the
 * app already holds. Every other connection gets exactly one owning client,
 * whether one tab uses it or six.
 */
export function clientFor(connectionId: string, profile?: null | string): ConnectionClient {
  if (isAmbientConnection(connectionId)) {
    return { kind: 'ambient' }
  }

  return { connectionId, kind: 'owning', scopeKey: scopeOf(connectionId, profile) }
}

/**
 * A tab bound to `connectionId` opened.
 *
 * Idempotent per tab: the caller holds once and releases once. The first hold on
 * a non-ambient connection pins the scope and opens its socket; later holds
 * share it, including one taken while the first is still opening (a cold SSH
 * dial is 45–90 s, and two tabs restored together must not start two dials).
 */
export async function holdConnectionClient(connectionId: string, profile?: null | string): Promise<void> {
  const client = clientFor(connectionId, profile)

  if (client.kind === 'ambient') {
    return
  }

  const { scopeKey } = client
  const existing = holds.get(scopeKey)

  if (existing) {
    existing.tabs += 1

    return existing.opening ?? undefined
  }

  const hold: Hold = { connectionId, opening: null, scopeKey, tabs: 1, unlisten: null }

  holds.set(scopeKey, hold)
  // BEFORE the open: a pin taken while the socket is still opening survives it,
  // so a slow dial cannot be evicted by an unrelated request-only lease landing
  // in the meantime.
  pinSecondary(scopeKey)

  hold.unlisten = addConnectionEventListener(connectionId, event => sink?.(event))

  hold.opening = leaseSecondary(scopeKey, connectionId)
    .then(() => undefined)
    .finally(() => {
      hold.opening = null
    })

  return hold.opening
}

/**
 * A tab bound to `connectionId` closed.
 *
 * The last one DEMOTES the socket to request-only: it stops routing frames (no
 * tab is listening) and joins the ordinary idle reap, so a reopen inside the
 * minute finds it warm. It is not closed here — that is a connection being
 * removed or edited, or quit.
 */
export function releaseConnectionClient(connectionId: string, profile?: null | string): void {
  const scopeKey = scopeOf(connectionId, profile)
  const hold = holds.get(scopeKey)

  if (!hold) {
    return
  }

  hold.tabs -= 1

  if (hold.tabs > 0) {
    return
  }

  holds.delete(scopeKey)
  hold.unlisten?.()
  hold.unlisten = null
  unpinSecondary(scopeKey)
}

/** Open tabs on this connection — what makes its client an owning one. */
export function connectionTabCount(connectionId: string, profile?: null | string): number {
  return holds.get(scopeOf(connectionId, profile))?.tabs ?? 0
}

/** Every connection currently holding an owning client. */
export function ownedConnections(): string[] {
  return [...holds.values()].map(hold => hold.connectionId)
}

export const __testing = {
  reset: (): void => {
    for (const hold of holds.values()) {
      hold.unlisten?.()
      unpinSecondary(hold.scopeKey)
    }

    holds.clear()
    sink = null
  }
}
