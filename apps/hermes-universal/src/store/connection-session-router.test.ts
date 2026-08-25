import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getGatewayClient, leaseSecondary, releaseSecondary, requestGateway } = vi.hoisted(() => ({
  getGatewayClient: vi.fn(() => null),
  leaseSecondary: vi.fn(),
  releaseSecondary: vi.fn(),
  requestGateway: vi.fn(async () => 'ambient')
}))

vi.mock('@/hermes', () => ({ setApiRequestProfile: vi.fn() }))
vi.mock('@/store/gateway-secondaries', () => ({ leaseSecondary, releaseSecondary }))
vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGatewayClient,
  requestGateway
}))

import type { Connection } from '@/store/gateway-config'

import { $activeConnection, describeConnection, publishActiveConnection } from './active-connection'
// The module IS the wiring: importing it registers the router. The binding is
// USED below on purpose — a named import nothing references is elided by the TS
// transform, which silently leaves MJXHRM-480's single-gateway router in place
// and turns every cross-source assertion here into a green lie. (Verified: drop
// the `registrySessionRouter.active()` assertion and four of these go red.)
import { registrySessionRouter } from './connection-session-router'
import { $gatewayState } from './gateway'
import { $gatewaySwitching } from './gateway-switch'
import { $activeSessionRoute, requestForSession, SessionRouteError } from './session-request-router'
import { forgetSessionSources, spliceRegistrySessionRows } from './session-sources'

const REMOTE: Connection = { authMode: 'none', baseUrl: 'https://gw.test', mode: 'remote' }

beforeEach(() => {
  requestGateway.mockClear()
  leaseSecondary.mockReset()
  releaseSecondary.mockReset()
  forgetSessionSources()
  $gatewayState.set('open')
  $gatewaySwitching.set(false)
  publishActiveConnection(
    describeConnection(REMOTE, { connectionId: 'studio', dialConnectionId: null, label: 'Studio' })
  )
})

describe('the registry router', () => {
  // 480 §9.1: the registry replaces the DERIVATION by registering, never by
  // adding a setter. A module-load registration is what makes that true.
  it('is registered at module load and drives the published route', () => {
    expect(registrySessionRouter.active().connectionId).toBe('studio')
    expect($activeSessionRoute.get().connectionId).toBe('studio')

    publishActiveConnection(
      describeConnection({ ...REMOTE, profile: 'work' }, {
        connectionId: 'laptop',
        dialConnectionId: 'laptop',
        label: 'Laptop'
      })
    )

    expect($activeSessionRoute.get().connectionId).toBe('laptop')
    expect($activeSessionRoute.get().scopeKey).toBe('conn:laptop::work')
  })

  it('dispatches the ACTIVE scope over the ambient socket and opens nothing', async () => {
    await requestForSession('s1', 'session.resume', { cols: 96 })

    expect(requestGateway).toHaveBeenCalledWith('session.resume', { cols: 96 })
    expect(leaseSecondary).not.toHaveBeenCalled()
  })

  it('leases a secondary for a FOREIGN source and releases it in finally', async () => {
    const request = vi.fn(async () => 'remote-answer')

    leaseSecondary.mockResolvedValue({ connectionId: 'laptop', request, scopeKey: 'conn:laptop::default' })
    // The merged rows' tag is what says where a session lives.
    spliceRegistrySessionRows([], [{ connection_id: 'laptop', ended_at: null, id: 's9', started_at: 1 } as never], 'studio')

    await expect(requestForSession('s9', 'session.resume', { cols: 96 })).resolves.toBe('remote-answer')

    expect(requestGateway).not.toHaveBeenCalled()
    // A cross-connection call always names its profile: the other backend has
    // no reason to share this one's ambient scope.
    expect(request).toHaveBeenCalledWith('session.resume', { cols: 96, profile: 'default' }, undefined)
    expect(releaseSecondary).toHaveBeenCalledTimes(1)
  })

  it('releases the lease even when the request throws', async () => {
    leaseSecondary.mockResolvedValue({
      connectionId: 'laptop',
      request: vi.fn(async () => {
        throw new Error('boom')
      }),
      scopeKey: 'conn:laptop::default'
    })
    spliceRegistrySessionRows([], [{ connection_id: 'laptop', ended_at: null, id: 's9', started_at: 1 } as never], 'studio')

    await expect(requestForSession('s9', 'session.resume')).rejects.toThrow('boom')
    expect(releaseSecondary).toHaveBeenCalledTimes(1)
  })

  it('reports an unreachable foreign source as a route failure, not a gateway error', async () => {
    leaseSecondary.mockRejectedValue(new Error('unreachable'))
    spliceRegistrySessionRows([], [{ connection_id: 'laptop', ended_at: null, id: 's9', started_at: 1 } as never], 'studio')

    await expect(requestForSession('s9', 'session.resume')).rejects.toBeInstanceOf(SessionRouteError)
  })

  it('refuses an ambient dispatch mid-switch and with a closed socket', async () => {
    $gatewaySwitching.set(true)
    await expect(requestForSession('s1', 'session.resume')).rejects.toBeInstanceOf(SessionRouteError)

    $gatewaySwitching.set(false)
    $gatewayState.set('closed')
    await expect(requestForSession('s1', 'session.resume')).rejects.toBeInstanceOf(SessionRouteError)
  })

  it('never hands a secondary out as the active gateway client', async () => {
    leaseSecondary.mockResolvedValue({
      connectionId: 'laptop',
      request: vi.fn(async () => 'x'),
      scopeKey: 'conn:laptop::default'
    })
    spliceRegistrySessionRows([], [{ connection_id: 'laptop', ended_at: null, id: 's9', started_at: 1 } as never], 'studio')

    await requestForSession('s9', 'session.resume')

    // A plugin holding a secondary would defeat its reap and start receiving
    // events for ids the session stores have never seen.
    expect(getGatewayClient()).toBeNull()
  })

  it('keeps the BARE scope key for the legacy owner, so no pool entry moves', () => {
    expect($activeConnection.get()?.dialConnectionId).toBeNull()
    expect($activeSessionRoute.get().scopeKey).toBe('default')
  })
})
