/**
 * The routing half of MJXHRM-480: a session RPC's route is a value read
 * immediately before the send, never one captured before an await.
 */

import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestGateway = vi.fn(async () => ({ ok: true }))
const $gatewayState = atom<string>('open')

vi.mock('@/store/gateway', () => ({
  $gatewayState,
  requestGateway: (...args: unknown[]) => requestGateway(...args)
}))

vi.mock('@/hermes', () => ({
  // `store/profiles.ts` calls this at module scope; the ambient route reads
  // `store/profile` → `store/profiles`.
  setApiRequestProfile: vi.fn()
}))

const { $gatewaySwitching } = await import('@/store/gateway-switch')
const { $activeProfile } = await import('@/store/profiles')

const {
  $activeSessionRoute,
  __resetSessionRequestRouter,
  requestForSession,
  SessionRouteError,
  sessionRpcNeedsProfileRoute,
  setSessionOwnerResolver,
  setSessionRequestRouter
} = await import('./session-request-router')

let owner: (id: string) => Promise<string | undefined> | string | undefined = () => undefined

setSessionOwnerResolver(id => owner(id))

const sentParams = () => requestGateway.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined

beforeEach(() => {
  requestGateway.mockClear()
  $gatewayState.set('open')
  $gatewaySwitching.set(false)
  $activeProfile.set(null)
  owner = () => undefined
  __resetSessionRequestRouter()
})

describe('sessionRpcNeedsProfileRoute', () => {
  it('routes ambient for a blank owner and for the live profile, pins anything else', () => {
    expect(sessionRpcNeedsProfileRoute(undefined, 'default')).toBe(false)
    expect(sessionRpcNeedsProfileRoute('  ', 'default')).toBe(false)
    expect(sessionRpcNeedsProfileRoute('default', 'default')).toBe(false)
    expect(sessionRpcNeedsProfileRoute('work', 'default')).toBe(true)
  })
})

describe('requestForSession', () => {
  // T20
  it('sends unscoped when the owner is unknown or is already the live route', async () => {
    await requestForSession('s1', 'session.resume', { session_id: 's1' })
    expect(sentParams()).toEqual({ session_id: 's1' })

    owner = () => 'default'
    await requestForSession('s1', 'session.resume', { session_id: 's1' })
    expect(sentParams()).toEqual({ session_id: 's1' })
  })

  // T21
  it('pins the owning profile when the live route diverges', async () => {
    owner = () => 'work'

    await requestForSession('s1', 'session.resume', { session_id: 's1' })

    expect(sentParams()).toEqual({ profile: 'work', session_id: 's1' })
  })

  // T22 — the whole point. `hydrateColdSession` can await a by-id probe across
  // every backend; a soft switch landing in that window changes which route is
  // live. Deciding before the await sends the resume to the wrong one.
  it('honours a route change that happens between resolving the owner and dispatching', async () => {
    $activeProfile.set('work')

    let release: (value: string) => void = () => {}

    owner = () =>
      new Promise<string>(resolve => {
        release = resolve
      })

    const inflight = requestForSession('s1', 'session.resume', { session_id: 's1' })

    // The user switches profile while the probe is still out. The owner is
    // 'work', which WAS the ambient route when the call started.
    $activeProfile.set(null)
    release('work')
    await inflight

    expect(sentParams()).toEqual({ profile: 'work', session_id: 's1' })
  })

  // T23
  it('throws a typed SessionRouteError while a switch is in flight, and while the socket is down', async () => {
    $gatewaySwitching.set(true)
    await expect(requestForSession('s1', 'session.resume')).rejects.toMatchObject({
      kind: 'switching',
      name: 'SessionRouteError'
    })

    $gatewaySwitching.set(false)
    $gatewayState.set('closed')
    await expect(requestForSession('s1', 'session.resume')).rejects.toBeInstanceOf(SessionRouteError)
    expect(requestGateway).not.toHaveBeenCalled()
  })

  // Rule 34: this error reaches toasts and spans, so it must carry a profile
  // scope key and never a gateway URL.
  it('carries the scope key and no URL', async () => {
    $activeProfile.set('work')
    $gatewayState.set('closed')

    const error = await requestForSession('s1', 'session.resume').catch((e: unknown) => e as SessionRouteError)

    expect(error.scopeKey).toBe('work')
    expect(`${error.message} ${error.scopeKey}`).not.toMatch(/https?:|127\.0\.0\.1|ws:/)
  })

  // T24 — universal's `requestGateway` takes (method, params, timeoutMs?) and
  // has NO `signal` parameter; call-site assertions read the observed shape.
  it('forwards timeoutMs only when supplied', async () => {
    await requestForSession('s1', 'session.usage')
    expect(requestGateway.mock.calls.at(-1)).toHaveLength(2)

    await requestForSession('s1', 'session.usage', {}, 5_000)
    expect(requestGateway.mock.calls.at(-1)).toEqual(['session.usage', {}, 5_000])
  })

  // The sync fast path is load-bearing (MJXHRM-81): a resume deferred by a
  // microtask is long enough for a second open to overtake it.
  it('does not defer the dispatch when the owner is known synchronously', () => {
    owner = () => 'work'

    void requestForSession('s1', 'session.resume', { session_id: 's1' })

    expect(requestGateway).toHaveBeenCalledTimes(1)
  })
})

describe('$activeSessionRoute', () => {
  // T25
  it('tracks profile activation, with the registration as its only writer', () => {
    expect($activeSessionRoute.get()).toEqual({
      connectionId: 'local',
      profile: 'default',
      scopeKey: 'default',
      scopeProfile: false
    })

    $activeProfile.set('work')
    expect($activeSessionRoute.get().profile).toBe('work')
    // T26's other half: the primary connection's scope key IS the bare profile.
    expect($activeSessionRoute.get().scopeKey).toBe('work')
  })

  it('follows a swapped router — including one with its own inputs — and restores idempotently', async () => {
    const $connection = atom('box-2')
    const dispatch = vi.fn(async () => ({ ok: true }))

    const restore = setSessionRequestRouter({
      active: () => ({
        connectionId: $connection.get(),
        profile: 'default',
        scopeKey: `conn:${$connection.get()}::default`,
        scopeProfile: false
      }),
      activeInputs: [$connection],
      dispatch,
      resolve() {
        return this.active()
      }
    })

    expect($activeSessionRoute.get().connectionId).toBe('box-2')

    // The replacement's OWN input moves the published route — no setter, and no
    // second writer.
    $connection.set('box-3')
    expect($activeSessionRoute.get().scopeKey).toBe('conn:box-3::default')

    await requestForSession('s1', 'session.resume')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(requestGateway).not.toHaveBeenCalled()

    restore()
    expect($activeSessionRoute.get().connectionId).toBe('local')
    // Stale restore: a second call must not re-install anything.
    restore()
    expect($activeSessionRoute.get().connectionId).toBe('local')
  })
})
