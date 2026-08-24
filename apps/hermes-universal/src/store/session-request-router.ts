/**
 * WHICH BACKEND SERVES THIS SESSION'S RPC — decided at DISPATCH time.
 *
 * Every session-scoped call resolves its owning profile first, and that
 * resolution can await (`resolveSessionProfile` probes each backend by id). The
 * ambient route is a moving target across that await: `softSwitchGateway` wipes
 * the session lists, closes the socket and re-dials with no coordination
 * (`store/gateway-soft-switch.ts`), so a resume dispatched on the route that was
 * live BEFORE the await either rejects with a bare "Hermes gateway is not
 * connected" or — once there is more than one connection (MJXHRM-446) — lands on
 * a backend that never heard of the session.
 *
 * So the route is a value re-read immediately before the send, never a variable
 * captured before an await. That is the whole idea, and the five `session.resume`
 * call sites go through `requestForSession` rather than `requestGateway` to get
 * it.
 *
 * SHAPE, deliberately: `SessionRequestRouter` is an interface with a
 * registration hook because MJXHRM-446 replaces the implementation wholesale —
 * its `dispatch` leases the registry's socket for `route.connectionId` instead
 * of using the single ambient one, and its `resolve` looks the owner up in the
 * registry. Nothing at the five call sites changes when it does.
 *
 * NOT here: connection descriptors, credentials, health probes, a second socket
 * (MJXHRM-446), and any notion of "warming" a route — activation is 446's, and
 * folding it in would give this module an unbounded await it has no budget for.
 */

import type { ReadableAtom } from 'nanostores'

import { backendScopeKey, LOCAL_CONNECTION_ID } from '@/lib/backend-scope'
import { atom, computed } from '@/store/atom'
import { $gatewayState, requestGateway } from '@/store/gateway'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'

export interface SessionRoute {
  /** Registry connection id. Today always `LOCAL_CONNECTION_ID` — there is one
   *  connection, whatever its gateway MODE (a phone has no local spawn and is
   *  still the primary connection). MJXHRM-446 mints the others. */
  connectionId: string
  /** Bare profile key, `normalizeProfileKey`d ('default' when unset). */
  profile: string
  /**
   * Whether this route's profile came from the session's OWNER rather than from
   * the ambient backend — i.e. whether `profile` may be pinned into the params
   * at all. Re-checked against the LIVE ambient route at dispatch, because an
   * owner that matched the ambient profile when the route was resolved may not
   * still match when the send happens.
   */
  scopeProfile: boolean
  /** `backendScopeKey(connectionId, profile)`. The pool/identity key the rest of
   *  Loop 3 keys on; for the primary connection it is the BARE profile, so a
   *  single-source user's keys stay byte-identical. */
  scopeKey: string
}

export type SessionRouteErrorKind = 'no-gateway' | 'route-moved' | 'switching'

/**
 * The route could not be honoured — as opposed to the session being broken.
 *
 * Carries only the scope key, never a base URL: a gateway URL is credential
 * material and this error reaches toasts and spans (rule 34).
 */
export class SessionRouteError extends Error {
  readonly kind: SessionRouteErrorKind
  readonly scopeKey: string

  constructor(kind: SessionRouteErrorKind, scopeKey: string) {
    super(`session route unavailable (${kind})`)
    this.name = 'SessionRouteError'
    this.kind = kind
    this.scopeKey = scopeKey
  }
}

export interface SessionRequestRouter {
  /** The route the live socket currently serves. Cheap and synchronous — it is
   *  called on every dispatch, and being called there IS the re-read. */
  active(): SessionRoute
  /** The atoms whose change can move `active()`. `$activeSessionRoute` is
   *  derived over exactly these, so a router with more inputs than the ambient
   *  profile stays correctly subscribed without anyone adding a setter. */
  activeInputs?: readonly ReadableAtom<unknown>[]
  /** Which route should serve this session. Synchronous: the caller has already
   *  resolved the owning profile. */
  resolve(input: { ownerProfile?: null | string; storedSessionId: null | string }): SessionRoute
  /** Send. Throws `SessionRouteError` when the route cannot be honoured. */
  dispatch<T>(route: SessionRoute, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

/**
 * Does this session's RPC have to carry `profile` in its params?
 *
 * Desktop's rule, verbatim in semantics: a blank owner routes ambient (never
 * guess — an unscoped call is the pre-existing "let the gateway decide" path),
 * an owner equal to the live route routes ambient too (the ambient dispatcher
 * carries the reauth-aware reconnect path), and anything else is pinned.
 */
export function sessionRpcNeedsProfileRoute(
  ownerProfile: null | string | undefined,
  activeProfile: null | string | undefined
): boolean {
  const owner = (ownerProfile ?? '').trim()

  return Boolean(owner) && owner !== (activeProfile ?? '').trim()
}

function routeFor(profile: string, scopeProfile: boolean): SessionRoute {
  return {
    connectionId: LOCAL_CONNECTION_ID,
    profile,
    scopeKey: backendScopeKey(LOCAL_CONNECTION_ID, profile),
    scopeProfile
  }
}

/**
 * The single-active-gateway router — not a stub.
 *
 * Rule 15 ("REST is profile-scoped, the chat WebSocket is not") is about EVENT
 * delivery. `session.resume`'s PARAMS already carry `profile`, and universal
 * already routes cross-profile resumes that way, so the route is real today: it
 * is a params-level route over one socket.
 */
const singleGatewayRouter: SessionRequestRouter = {
  active: () => routeFor(normalizeProfileKey($activeGatewayProfile.get()), false),

  activeInputs: [$activeGatewayProfile],

  dispatch<T>(route: SessionRoute, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    // THE RE-READ. Everything above this line may have been decided before an
    // await; everything below is one synchronous step.
    const active = normalizeProfileKey($activeGatewayProfile.get())

    if ($gatewaySwitching.get()) {
      throw new SessionRouteError('switching', route.scopeKey)
    }

    if ($gatewayState.get() !== 'open') {
      throw new SessionRouteError('no-gateway', route.scopeKey)
    }

    const scoped = route.scopeProfile && sessionRpcNeedsProfileRoute(route.profile, active)

    // Arity contract: `timeoutMs` is forwarded ONLY when the caller supplied it.
    // `requestGateway` has three parameters and call-site assertions read the
    // observed shape; universal has no `signal` parameter and must not invent
    // one.
    const sent = scoped ? { ...params, profile: route.profile } : params

    return timeoutMs === undefined ? requestGateway<T>(method, sent) : requestGateway<T>(method, sent, timeoutMs)
  },

  resolve({ ownerProfile }): SessionRoute {
    const owner = (ownerProfile ?? '').trim()

    return owner ? routeFor(normalizeProfileKey(owner), true) : this.active()
  }
}

// One writer, and it is this hook. `$activeSessionRoute` is derived THROUGH the
// registration, so MJXHRM-446 replaces the derivation by registering its router
// — never by adding a setter, which is how desktop's `$activeGatewayRoute`
// drifted from the socket it was supposed to describe.
const $currentRouter = atom<SessionRequestRouter>(singleGatewayRouter)

const $ambientRoute = atom<SessionRoute>(singleGatewayRouter.active())

let unbindActiveRoute: (() => void) | null = null

function bindActiveRoute(router: SessionRequestRouter): void {
  unbindActiveRoute?.()

  const inputs = router.activeInputs ?? [$activeGatewayProfile]
  // `subscribe` fires immediately, so the published route is correct before this
  // returns.
  unbindActiveRoute = computed([...inputs], () => router.active()).subscribe(route => $ambientRoute.set(route))
}

bindActiveRoute(singleGatewayRouter)

/** Universal's answer to desktop's `$activeGatewayRoute`: the live route, as a
 *  value. Read-only by contract — the only writer is the derivation above. */
export const $activeSessionRoute: ReadableAtom<SessionRoute> = $ambientRoute

/**
 * Register the router. Returns an IDEMPOTENT restore that only restores if this
 * router is still the current one — the house shape (`setSessionTransitionHook`,
 * `addGatewayEventListener`, `setConnectionIdResolver`).
 */
export function setSessionRequestRouter(router: SessionRequestRouter): () => void {
  const previous = $currentRouter.get()

  $currentRouter.set(router)
  bindActiveRoute(router)

  return () => {
    if ($currentRouter.get() === router) {
      $currentRouter.set(previous)
      bindActiveRoute(previous)
    }
  }
}

/** Test seam. */
export function __resetSessionRequestRouter(): void {
  $currentRouter.set(singleGatewayRouter)
  bindActiveRoute(singleGatewayRouter)
}

/**
 * Which profile's database holds this session.
 *
 * A HOOK, not an import: the answer lives in `store/session.ts`, which imports
 * `requestForSession` from here, and recipe 6.4's rule for an unavoidable cycle
 * is a registration hook (`setSessionTransitionHook`, `addSessionKeyHooks`,
 * `setStreamBatchSink`). It also keeps the light modules that only dispatch —
 * `session-recovery.ts`, `turn-lifecycle.ts` — off the whole session graph.
 *
 * SYNCHRONOUS WHENEVER IT CAN BE, and that is load-bearing: a loaded row carries
 * its own profile stamp and a single-profile install has nothing to route, so an
 * unconditional promise would defer every resume by a microtask — long enough
 * for a second open to overtake it (MJXHRM-81). Only a genuine miss on a
 * multi-profile install returns one.
 */
export type SessionOwnerResolver = (storedSessionId: string) => Promise<string | undefined> | string | undefined

/** With none registered every route is ambient — exactly the pre-existing
 *  "let the gateway decide" behaviour, never a guess. */
let ownerResolver: null | SessionOwnerResolver = null

export function setSessionOwnerResolver(resolver: SessionOwnerResolver): () => void {
  const previous = ownerResolver

  ownerResolver = resolver

  return () => {
    if (ownerResolver === resolver) {
      ownerResolver = previous
    }
  }
}

/**
 * THE session-RPC verb: resolve the owning profile, then resolve and dispatch
 * the route in ONE synchronous step.
 *
 * The owner resolution is the only await, and it is skipped entirely when the
 * answer is already known — see `SessionOwnerResolver`.
 */
export async function requestForSession<T>(
  storedSessionId: null | string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<T> {
  const pending = storedSessionId ? ownerResolver?.(storedSessionId) : undefined
  const ownerProfile = pending instanceof Promise ? await pending : pending

  // RESOLVE AND DISPATCH WITH NO AWAIT BETWEEN THEM.
  const router = $currentRouter.get()

  return router.dispatch<T>(router.resolve({ ownerProfile, storedSessionId }), method, params, timeoutMs)
}
