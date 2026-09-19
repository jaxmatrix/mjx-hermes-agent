import { backendScopeKey, LOCAL_CONNECTION_ID } from '@/lib/backend-scope'
import { $activeConnection } from '@/store/active-connection'
import { migrateLegacyBubbles } from '@/store/chat-bubbles'
import { connectionScopeKey } from '@/store/connection-clients'
import { isTunnelSignInError } from '@/store/connection-tunnels'
import { $connectionsRegistry } from '@/store/connections'
import { $gatewayState, requestGateway, setGatewayRequestProfile } from '@/store/gateway-client'
import { leaseSecondary, releaseSecondary } from '@/store/gateway-secondaries'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import {
  legacyRouteNeedsProfileParam,
  type SessionRequestRouter,
  type SessionRoute,
  SessionRouteError,
  setSessionRequestRouter
} from '@/store/session-route-dispatch'
import { connectionIdForSession } from '@/store/session-sources'
import { migrateLegacyTiles, setSessionRefResolver } from '@/store/session-states'

/**
 * THE MULTI-CONNECTION ROUTER — MJXHRM-480's interface, second implementation.
 *
 * 480 published `SessionRequestRouter` with a registration hook precisely so
 * this could be swapped in without touching the five `session.resume` call
 * sites, and it is not touched: `requestForSession` still resolves the owner and
 * dispatches in one synchronous step. What changes is only WHERE the dispatch
 * lands — the ambient socket when the route is the active scope, a leased
 * secondary when it is not.
 *
 * The re-read discipline is 480's and is preserved verbatim: `dispatch` reads
 * the live route immediately before the send, never a value captured before an
 * await, because `softSwitchGateway` can wipe and re-dial across that await.
 */

function routeFor(connectionId: string, profile: string, scopeProfile: boolean): SessionRoute {
  const active = $activeConnection.get()

  return {
    connectionId,
    profile,
    // The DIAL id, not the registry id: the legacy owner's key is the bare
    // profile, and using the registry id here would re-key every pool entry a
    // single-source install already has.
    scopeKey: backendScopeKey(
      active && active.connectionId === connectionId ? active.dialConnectionId : connectionId,
      profile
    ),
    scopeProfile
  }
}

function activeRoute(): SessionRoute {
  const active = $activeConnection.get()
  const profile = normalizeProfileKey(active?.profile ?? $activeGatewayProfile.get())

  return {
    connectionId: active?.connectionId ?? LOCAL_CONNECTION_ID,
    profile,
    scopeKey: active?.scopeKey ?? backendScopeKey(null, profile),
    scopeProfile: false
  }
}

export const registrySessionRouter: SessionRequestRouter = {
  active: activeRoute,

  // `$activeConnection` joins the ambient profile as an input, so
  // `$activeSessionRoute` re-derives when the SOURCE moves and not only when the
  // profile does. 480 derives the published route over exactly these.
  activeInputs: [$activeConnection, $activeGatewayProfile],

  async dispatch<T>(
    route: SessionRoute,
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T> {
    // THE RE-READ.
    const active = activeRoute()

    if (route.scopeKey === active.scopeKey) {
      if ($gatewaySwitching.get()) {
        throw new SessionRouteError('switching', route.scopeKey)
      }

      if ($gatewayState.get() !== 'open') {
        throw new SessionRouteError('no-gateway', route.scopeKey)
      }

      const scoped = route.scopeProfile && legacyRouteNeedsProfileParam(route.profile, active.profile)
      const sent = scoped ? { ...params, profile: route.profile } : params

      // Arity contract (480): `timeoutMs` is forwarded ONLY when supplied.
      return timeoutMs === undefined ? requestGateway<T>(method, sent) : requestGateway<T>(method, sent, timeoutMs)
    }

    // The SAME connection, another profile. The gateway serves every profile over
    // one socket and takes `profile` on the request, so this goes over the socket
    // the app already holds. A secondary here bought nothing and cost three
    // things: `connections_resolve` needs a registry row a URL connection may not
    // have, so it failed outright as `no-gateway`; `local` and `ssh` have no
    // address a second socket could dial at all; and a session resumed over one
    // streams its events to a socket reaped after a minute idle — not to the chat
    // the user is looking at.
    if (route.connectionId === active.connectionId) {
      if ($gatewaySwitching.get()) {
        throw new SessionRouteError('switching', route.scopeKey)
      }

      if ($gatewayState.get() !== 'open') {
        throw new SessionRouteError('no-gateway', route.scopeKey)
      }

      const scoped = { ...params, profile: route.profile }

      return timeoutMs === undefined ? requestGateway<T>(method, scoped) : requestGateway<T>(method, scoped, timeoutMs)
    }

    // Another source. A secondary is request-only and is never handed out as
    // "the gateway" — see `store/gateway-secondaries.ts`.
    let lease: Awaited<ReturnType<typeof leaseSecondary>>

    try {
      // ONE socket per CONNECTION (MJXHRM-591, Design v1.3 N2), not per
      // connection+profile: `connections_resolve` is already called with
      // `profile: null`, so the socket was never profile-specific, and the call
      // below names its profile anyway. Two pool keys for two profiles of one
      // connection meant two sockets, two streams of the same events and two
      // tunnel holds.
      lease = await leaseSecondary(connectionScopeKey(route.connectionId), route.connectionId)
    } catch (error) {
      throw new SessionRouteError(isTunnelSignInError(error) ? 'needs-sign-in' : 'no-gateway', route.scopeKey)
    }

    try {
      // A cross-connection call ALWAYS names its profile: the secondary's
      // backend has no reason to share the active source's ambient one.
      return await lease.request<T>(method, { ...params, profile: route.profile }, timeoutMs)
    } finally {
      releaseSecondary(lease)
    }
  },

  /**
   * The route to a connection the CALLER names — a bound tab's own (MJXHRM-591,
   * invariant 29). The dispatch is unchanged, so a ref that IS the active
   * connection still rides the ambient socket, and any other lands on that
   * connection's socket — which, for a connection with an open tab, is the
   * pinned owning client `leaseSecondary` hands straight back.
   */
  resolveRef({ connectionId, profile }): SessionRoute {
    const active = activeRoute()
    const profileKey = normalizeProfileKey(profile ?? active.profile)

    return routeFor(connectionId, profileKey, connectionId !== active.connectionId || profileKey !== active.profile)
  },

  resolve({ ownerProfile, storedSessionId }): SessionRoute {
    const active = activeRoute()
    const owner = (ownerProfile ?? '').trim()
    // The merged rows' tag, never the registry's `primary` — `primary` is the
    // default for the next launch, not a claim about where this session lives.
    const connectionId = connectionIdForSession(storedSessionId) ?? active.connectionId
    const profile = owner ? normalizeProfileKey(owner) : active.profile

    return routeFor(
      connectionId,
      profile,
      connectionId !== active.connectionId || (Boolean(owner) && profile !== active.profile)
    )
  }
}

setSessionRequestRouter(registrySessionRouter)

// Every primary RPC that names no profile rides the active one (MJXHRM-592): the
// same rule `dispatch` applies to a same-connection route, for the calls that do
// not come through a route. `default` is the launch profile, so it is omitted.
setGatewayRequestProfile(() => {
  const profile = normalizeProfileKey($activeGatewayProfile.get())

  return profile === 'default' ? null : profile
})

// Where a tab for a bare stored id belongs (MJXHRM-591). The SAME answer this
// router dispatches on — the merged rows' owner, else the connection the app is
// on — resolved once, when the tab opens, and carried by the tab from then on.
// Registered here rather than imported by the tile layer, so the dependency
// keeps pointing one way.
setSessionRefResolver(storedSessionId => {
  const active = activeRoute()

  return {
    connectionId: connectionIdForSession(storedSessionId) ?? active.connectionId,
    profile: active.profile,
    storedSessionId
  }
})

// v2 tabs were keyed by profile alone, so the only connection they could have
// belonged to is the one the app was pointed at: the registry's primary. Run as
// soon as the registry names it, and once.
let tilesMigrated = false

$connectionsRegistry.listen(registry => {
  if (!tilesMigrated && registry.connections.length > 0) {
    tilesMigrated = true
    migrateLegacyTiles(registry.primary)
    migrateLegacyBubbles(registry.primary)
  }
})
