/**
 * MJXHRM-591 — the owning client: one socket per connection, held by its tabs.
 *
 * Invariant 32: one socket per connection, and a tab on the ACTIVE connection
 *               opens none — the app already holds that socket.
 * Invariant 33: a pinned client is never evicted by the request-only cap and
 *               never idle-reaped.
 * Invariant 34: the last tab closing DEMOTES the socket to request-only; it is
 *               reaped by the ordinary idle window, not closed on the spot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  acquireTunnel,
  close: closeClient,
  connect,
  invoke,
  onAny,
  request
} = vi.hoisted(() => ({
  acquireTunnel: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(async (_url: string) => {}),
  invoke: vi.fn(),
  onAny: vi.fn(),
  request: vi.fn(async () => 'ok')
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/store/connection-tunnels', () => ({ acquireTunnel }))
vi.mock('@/store/session-request-router', () => ({
  SessionRouteError: class extends Error {
    constructor(
      readonly kind: string,
      readonly scopeKey: string
    ) {
      super(`session route unavailable (${kind})`)
    }
  }
}))
vi.mock('@/transport/tauri-websocket', () => ({ TauriWebSocket: class {} }))
vi.mock('@/gateway', () => ({
  JsonRpcGatewayClient: class {
    close = closeClient
    connect = async (url: string) => {
      await connect(url)
    }
    onAny = onAny
    request = request

    constructor(_options: unknown) {}
  }
}))

import { $activeConnection } from '@/store/active-connection'
import {
  clientFor,
  __testing as clientTesting,
  connectionTabCount,
  holdConnectionClient,
  ownedConnections,
  releaseConnectionClient
} from '@/store/connection-clients'
import { __testing, IDLE_REAP_MS, leaseSecondary, MAX_SECONDARIES, releaseSecondary } from '@/store/gateway-secondaries'

const activeOn = (connectionId: null | string) =>
  $activeConnection.set(
    connectionId ? ({ connectionId, profile: 'default', scopeKey: connectionId } as unknown as never) : null
  )

beforeEach(() => {
  vi.useFakeTimers()
  clientTesting.reset()
  __testing.reset()

  for (const spy of [acquireTunnel, connect, invoke, onAny, request, closeClient]) {
    spy.mockClear()
  }

  invoke.mockResolvedValue({ baseUrl: 'https://gw.test' })
  activeOn('conn-active')
})

afterEach(() => {
  vi.useRealTimers()
  activeOn(null)
})

describe('invariant 32 — one socket per connection', () => {
  it('opens nothing for a tab on the active connection', async () => {
    expect(clientFor('conn-active')).toEqual({ kind: 'ambient' })

    await holdConnectionClient('conn-active')

    expect(connect).not.toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).toEqual([])
    expect(ownedConnections()).toEqual([])
  })

  it('opens one socket for a background connection, however many tabs use it', async () => {
    expect(clientFor('conn-b')).toMatchObject({ connectionId: 'conn-b', kind: 'owning' })

    await holdConnectionClient('conn-b')
    await holdConnectionClient('conn-b')
    await holdConnectionClient('conn-b')

    expect(connect).toHaveBeenCalledTimes(1)
    expect(__testing.liveScopeKeys()).toEqual(['conn:conn-b::default'])
    expect(connectionTabCount('conn-b')).toBe(3)
  })
})

describe('invariant 33 — a pinned client is never reaped or evicted', () => {
  it('survives the idle window with no request on it', async () => {
    await holdConnectionClient('conn-b')

    vi.advanceTimersByTime(IDLE_REAP_MS * 10)

    expect(closeClient).not.toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).toContain('conn:conn-b::default')
    expect(__testing.isPinned('conn:conn-b::default')).toBe(true)
  })

  it('is not the victim when request-only leases hit the cap', async () => {
    await holdConnectionClient('conn-b')

    // Every one of these is request-only, and older than nothing: the cap must
    // evict among themselves and leave the tab's socket alone.
    for (let n = 0; n <= MAX_SECONDARIES; n += 1) {
      const lease = await leaseSecondary(`conn:req::p${n}`, 'req')

      releaseSecondary(lease)
      vi.advanceTimersByTime(1)
    }

    expect(__testing.liveScopeKeys()).toContain('conn:conn-b::default')
    expect(__testing.liveScopeKeys().filter(key => key.startsWith('conn:req::'))).toHaveLength(MAX_SECONDARIES)
  })
})

describe('invariant 34 — the last tab demotes the socket, it does not kill it', () => {
  it('keeps the socket live at t+0 and reaps it at t+60s', async () => {
    await holdConnectionClient('conn-b')
    await holdConnectionClient('conn-b')

    releaseConnectionClient('conn-b')

    expect(connectionTabCount('conn-b')).toBe(1)
    expect(__testing.isPinned('conn:conn-b::default')).toBe(true)

    releaseConnectionClient('conn-b')

    // Demoted: still live, still warm, no longer pinned.
    expect(closeClient).not.toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).toContain('conn:conn-b::default')
    expect(__testing.isPinned('conn:conn-b::default')).toBe(false)

    vi.advanceTimersByTime(IDLE_REAP_MS + 1)

    expect(closeClient).toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).not.toContain('conn:conn-b::default')
  })

  it('finds the socket warm when a tab reopens inside the window', async () => {
    await holdConnectionClient('conn-b')
    releaseConnectionClient('conn-b')

    vi.advanceTimersByTime(IDLE_REAP_MS - 1)
    await holdConnectionClient('conn-b')
    vi.advanceTimersByTime(IDLE_REAP_MS * 2)

    expect(connect).toHaveBeenCalledTimes(1)
    expect(closeClient).not.toHaveBeenCalled()
    expect(__testing.isPinned('conn:conn-b::default')).toBe(true)
  })
})
