import { backendScopeKey, LOCAL_CONNECTION_ID } from '@/lib/backend-scope'
import { $activeConnection } from '@/store/active-connection'
import { $gatewayState, requestGateway } from '@/store/gateway'
import { leaseSecondary, releaseSecondary } from '@/store/gateway-secondaries'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import {
  type SessionRequestRouter,
  type SessionRoute,
  SessionRouteError,
  sessionRpcNeedsProfileRoute,
  setSessionRequestRouter
} from '@/store/session-request-router'
import { connectionIdForSession } from '@/store/session-sources'

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

      const scoped = route.scopeProfile && sessionRpcNeedsProfileRoute(route.profile, active.profile)
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
    const lease = await leaseSecondary(route.scopeKey, route.connectionId).catch(() => null)

    if (!lease) {
      throw new SessionRouteError('no-gateway', route.scopeKey)
    }

    try {
      // A cross-connection call ALWAYS names its profile: the secondary's
      // backend has no reason to share the active source's ambient one.
      return await lease.request<T>(method, { ...params, profile: route.profile }, timeoutMs)
    } finally {
      releaseSecondary(lease)
    }
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
