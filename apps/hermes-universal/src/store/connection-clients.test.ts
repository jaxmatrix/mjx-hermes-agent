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
vi.mock('@/store/connection-tunnels', () => ({
  acquireTunnel,
  // 592's two "retrying cannot fix this" reads.
  isTunnelSignInError: (error: unknown) => (error as { kind?: string })?.kind === 'credentials-needed',
  needsInteraction: () => false
}))
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
  $connectionClients,
  clientFor,
  __testing as clientTesting,
  connectionClientState,
  connectionTabCount,
  holdConnectionClient,
  ownedConnections,
  releaseConnectionClient,
  retryConnectionClient,
  setConnectionClientTransport
} from '@/store/connection-clients'
import { __testing, IDLE_REAP_MS, leaseSecondary, MAX_SECONDARIES, releaseSecondary } from '@/store/gateway-secondaries'

const activeOn = (connectionId: null | string) =>
  $activeConnection.set(
    connectionId ? ({ connectionId, profile: 'default', scopeKey: connectionId } as unknown as never) : null
  )

beforeEach(() => {
  vi.useFakeTimers()
  __testing.reset()
  clientTesting.reset()

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

/**
 * MJXHRM-591, invariant 35's other half — the ladder and the catch-up.
 *
 * A socket a tab is streaming on can go away: its tunnel moves, the host sleeps,
 * the gateway restarts. The tabs keep their slices and their runtime ids —
 * that is what makes a catch-up possible — and the client climbs a full-jitter
 * ladder while a tab still wants it. A tunnel that needs a credential is the one
 * failure retrying cannot fix, so the ladder stops and the surface says so.
 */
describe('the reconnect ladder', () => {
  it('goes degraded and climbs when a pinned socket is lost', async () => {
    await holdConnectionClient('conn-b')

    expect(connectionClientState('conn-b')).toMatchObject({ phase: 'live' })

    const { __testing: secondaries } = await import('@/store/gateway-secondaries')

    // The socket goes: a tunnel move, a host asleep. Nothing else changes.
    secondaries.closePinned('conn:conn-b::default')

    expect(connectionClientState('conn-b')).toMatchObject({ phase: 'degraded' })

    connect.mockClear()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(connect).toHaveBeenCalled()
    expect(connectionClientState('conn-b')).toMatchObject({ phase: 'live' })
  })

  it('stops the ladder on a failure retrying cannot fix, and offers a retry', async () => {
    invoke.mockRejectedValueOnce({ kind: 'credentials-needed', message: 'sign in' })

    await holdConnectionClient('conn-b')

    expect(connectionClientState('conn-b')).toMatchObject({ phase: 'lost', terminal: true })

    connect.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)

    // No ladder: a credential is the user's to give.
    expect(connect).not.toHaveBeenCalled()

    invoke.mockResolvedValue({ baseUrl: 'https://gw.test' })
    retryConnectionClient('conn-b')
    await vi.advanceTimersByTimeAsync(1)

    expect(connectionClientState('conn-b')).toMatchObject({ phase: 'live' })
  })

  it('stops climbing once the last tab has gone', async () => {
    await holdConnectionClient('conn-b')

    const { __testing: secondaries } = await import('@/store/gateway-secondaries')

    // Lost, ladder armed — and then the user closes the tab that wanted it. A
    // ladder climbing against a gateway nobody is watching is exactly what
    // `gateway-secondaries` refuses to do on its own (rule 6).
    secondaries.closePinned('conn:conn-b::default')
    expect(connectionClientState('conn-b')).toMatchObject({ phase: 'degraded' })

    releaseConnectionClient('conn-b')

    connect.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(connect).not.toHaveBeenCalled()
    expect($connectionClients.get()['conn-b']).toBeUndefined()
  })
})

describe('the catch-up a reconnect runs', () => {
  const seedBound = async () => {
    const { $sessionStates, emptySessionState, publishSessionState, runtimeKeyFor } =
      await import('@/store/session-state-types')

    const key = runtimeKeyFor('conn-b', 'run-b')

    $sessionStates.set({})
    publishSessionState(key, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-b',
      profile: 'default',
      runtimeSessionId: 'run-b'
    })
    // A live session on ANOTHER connection, with the same stored id: this
    // client's catch-up is none of its business.
    publishSessionState(runtimeKeyFor('conn-c', 'run-c'), {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-c',
      profile: 'default',
      runtimeSessionId: 'run-c'
    })

    return key
  }

  it('asks from the watermark, re-delivers open requests, and folds the frames', async () => {
    const { __testing: replayTesting, noteConnectionEpoch, noteReplaySeq } = await import('@/store/session-replay')
    const key = await seedBound()

    replayTesting.reset()
    noteConnectionEpoch('conn-b', 'e1')
    noteReplaySeq(key, 7, 'e1')

    const asked: { method: string; params: Record<string, unknown> }[] = []
    const folded: unknown[] = []
    const rebound: string[] = []

    setConnectionClientTransport({
      rebind: async sessionKey => {
        rebound.push(sessionKey)
      },
      request: async (_scope, method, params) => {
        asked.push({ method, params })

        return {
          epoch: 'e1',
          events: [{ seq: 8, session_id: 'run-b', type: 'status.update' }],
          open_requests: [{ session_id: 'run-b', type: 'clarify.request' }],
          truncated: false
        }
      }
    })

    const { setConnectionEventSink } = await import('@/store/connection-clients')

    setConnectionEventSink(event => folded.push(event))

    await holdConnectionClient('conn-b')

    // ONE ask, for this connection's own session — not the identically-named one
    // on conn-c, whose socket knows nothing about this watermark.
    expect(asked).toEqual([{ method: 'session.events.since', params: { last_seen: 7, session_id: 'run-b' } }])
    // The parked question FIRST, then the frames it was waiting behind.
    expect((folded[0] as { type: string }).type).toBe('clarify.request')
    expect(folded[1] as { connectionId: string; type: string }).toMatchObject({
      connectionId: 'conn-b',
      type: 'status.update'
    })
    expect(rebound).toEqual([])
  })

  it('re-binds instead of asking when the epoch moved', async () => {
    const { __testing: replayTesting, noteConnectionEpoch, noteReplaySeq } = await import('@/store/session-replay')
    const key = await seedBound()

    replayTesting.reset()
    noteReplaySeq(key, 7, 'e1')
    // The backend restarted its log while we were away.
    noteConnectionEpoch('conn-b', 'e2')

    const asked: string[] = []
    const rebound: string[] = []

    setConnectionClientTransport({
      rebind: async sessionKey => {
        rebound.push(sessionKey)
      },
      request: async (_scope, method) => {
        asked.push(method)

        return {}
      }
    })

    await holdConnectionClient('conn-b')

    expect(asked).toEqual([])
    expect(rebound).toEqual([key])
  })

  it('re-binds when the ring could not cover the gap', async () => {
    const { __testing: replayTesting, noteConnectionEpoch, noteReplaySeq } = await import('@/store/session-replay')
    const key = await seedBound()

    replayTesting.reset()
    noteConnectionEpoch('conn-b', 'e1')
    noteReplaySeq(key, 7, 'e1')

    const rebound: string[] = []

    setConnectionClientTransport({
      rebind: async sessionKey => {
        rebound.push(sessionKey)
      },
      request: async () => ({ epoch: 'e1', events: [{ seq: 99 }], truncated: true })
    })

    await holdConnectionClient('conn-b')

    expect(rebound).toEqual([key])
  })
})
