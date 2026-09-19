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
vi.mock('@/store/session-route-dispatch', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
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
  type ClientHold,
  __testing as clientTesting,
  connectionClientState,
  connectionHoldCount,
  holdConnectionClient,
  ownedConnections,
  releaseConnectionClient,
  retryConnectionClient,
  setConnectionClientTransport
} from '@/store/connection-clients'

/** Take a hold the way a TAB RECORD does, and remember it: a hold is given
 *  back, never counted down (invariant 47). */
const taken: ClientHold[] = []

const hold = async (connectionId: string): Promise<ClientHold> => {
  const next = holdConnectionClient(connectionId, { ambient: false })!

  taken.push(next)
  // The open is in flight; a tab waits for it the same way.
  await vi.advanceTimersByTimeAsync(0)

  return next
}

/** Give back the most recent hold on a connection. */
const drop = (connectionId: string): void => {
  for (let index = taken.length - 1; index >= 0; index -= 1) {
    if (taken[index].connectionId === connectionId) {
      releaseConnectionClient(taken.splice(index, 1)[0])

      return
    }
  }
}

import { __testing, IDLE_REAP_MS, leaseSecondary, MAX_SECONDARIES, releaseSecondary } from '@/store/gateway-secondaries'

const activeOn = (connectionId: null | string) =>
  $activeConnection.set(
    connectionId ? ({ connectionId, profile: 'default', scopeKey: connectionId } as unknown as never) : null
  )

beforeEach(() => {
  vi.useFakeTimers()
  __testing.reset()
  taken.length = 0
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

    holdConnectionClient('conn-active', { ambient: true })

    expect(connect).not.toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).toEqual([])
    expect(ownedConnections()).toEqual([])
  })

  it('opens one socket for a background connection, however many tabs use it', async () => {
    expect(clientFor('conn-b')).toMatchObject({ connectionId: 'conn-b', kind: 'owning' })

    await hold('conn-b')
    await hold('conn-b')
    await hold('conn-b')

    expect(connect).toHaveBeenCalledTimes(1)
    expect(__testing.liveScopeKeys()).toEqual(['conn:conn-b::default'])
    expect(connectionHoldCount('conn-b')).toBe(3)
  })
})

describe('invariant 33 — a pinned client is never reaped or evicted', () => {
  it('survives the idle window with no request on it', async () => {
    await hold('conn-b')

    vi.advanceTimersByTime(IDLE_REAP_MS * 10)

    expect(closeClient).not.toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).toContain('conn:conn-b::default')
    expect(__testing.isPinned('conn:conn-b::default')).toBe(true)
  })

  it('is not the victim when request-only leases hit the cap', async () => {
    await hold('conn-b')

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
    await hold('conn-b')
    await hold('conn-b')

    drop('conn-b')

    expect(connectionHoldCount('conn-b')).toBe(1)
    expect(__testing.isPinned('conn:conn-b::default')).toBe(true)

    drop('conn-b')

    // Demoted: still live, still warm, no longer pinned.
    expect(closeClient).not.toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).toContain('conn:conn-b::default')
    expect(__testing.isPinned('conn:conn-b::default')).toBe(false)

    vi.advanceTimersByTime(IDLE_REAP_MS + 1)

    expect(closeClient).toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).not.toContain('conn:conn-b::default')
  })

  it('finds the socket warm when a tab reopens inside the window', async () => {
    await hold('conn-b')
    drop('conn-b')

    vi.advanceTimersByTime(IDLE_REAP_MS - 1)
    await hold('conn-b')
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
    await hold('conn-b')

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

    await hold('conn-b')

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
    await hold('conn-b')

    const { __testing: secondaries } = await import('@/store/gateway-secondaries')

    // Lost, ladder armed — and then the user closes the tab that wanted it. A
    // ladder climbing against a gateway nobody is watching is exactly what
    // `gateway-secondaries` refuses to do on its own (rule 6).
    secondaries.closePinned('conn:conn-b::default')
    expect(connectionClientState('conn-b')).toMatchObject({ phase: 'degraded' })

    drop('conn-b')

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

  it('asks from the watermark and folds only what the backend stamped', async () => {
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

        // The real answer shape (`methods_session.py:2219-2221`).
        return {
          count: 1,
          epoch: 'e1',
          events: [{ seq: 8, session_id: 'run-b', type: 'status.update' }],
          latest_seq: 8,
          open_requests: [],
          truncated: false
        }
      }
    })

    const { setConnectionEventSink } = await import('@/store/connection-clients')

    setConnectionEventSink(event => folded.push(event))

    await hold('conn-b')

    // ONE ask, for this connection's own session — not the identically-named one
    // on conn-c, whose socket knows nothing about this watermark.
    expect(asked).toEqual([{ method: 'session.events.since', params: { last_seen: 7, session_id: 'run-b' } }])
    // Invariant 48: every frame came from the ring, and carries its connection.
    expect(folded).toHaveLength(1)
    expect(folded[0] as { connectionId: string; type: string }).toMatchObject({
      connectionId: 'conn-b',
      type: 'status.update'
    })
    expect(rebound).toEqual([])
  })

  /**
   * MJXHRM-591 invariant 48 — `open_requests` is a SIGNAL, not a frame source.
   *
   * A snapshot is a JSON-RPC REQUEST (`{id, method, params}`,
   * `tui_gateway/server_requests.py`), and universal has no server→client
   * request path at all: its client handles `frame.method === 'event'` and
   * nothing else. Synthesising an event from one would put an unstamped frame
   * into the router — so a non-empty list means re-bind, which is the path that
   * restores a parked prompt from the resume payload.
   */
  it('re-binds on a parked question rather than synthesising a frame for it', async () => {
    const { __testing: replayTesting, noteConnectionEpoch, noteReplaySeq } = await import('@/store/session-replay')
    const key = await seedBound()

    replayTesting.reset()
    noteConnectionEpoch('conn-b', 'e1')
    noteReplaySeq(key, 7, 'e1')

    const folded: unknown[] = []
    const rebound: string[] = []

    setConnectionClientTransport({
      rebind: async sessionKey => {
        rebound.push(sessionKey)
      },
      request: async () => ({
        count: 0,
        epoch: 'e1',
        events: [],
        latest_seq: 7,
        // The REAL snapshot shape — a request, with no `type` at all.
        open_requests: [{ id: 41, method: 'clarify', params: { question: 'which?', session_id: 'run-b' } }],
        truncated: false
      })
    })

    const { setConnectionEventSink } = await import('@/store/connection-clients')

    setConnectionEventSink(event => folded.push(event))

    await hold('conn-b')

    expect(rebound).toEqual([key])
    // Nothing without a `type`, and nothing without a connection, reached the
    // router — which is to say: nothing this loop made up.
    expect(folded).toEqual([])
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

    await hold('conn-b')

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

    await hold('conn-b')

    expect(rebound).toEqual([key])
  })
})

/**
 * MJXHRM-591 invariant 47 — holds equal the held tab set, at every commit.
 *
 * The reviewer named the old version of this file's demote test as modelling
 * the happy path: it counted hold/release calls by hand, which is exactly the
 * bookkeeping the design moved into the tab stores. These drive the REAL
 * commit — `saveSessionTiles` — and read the hold count back.
 */
describe('invariant 47 — the tab records own the holds', () => {
  const tab = (connectionId: string, storedSessionId: string, rest: Record<string, unknown> = {}) => ({
    connectionId,
    profile: 'default',
    storedSessionId,
    tileKey: `@${connectionId}|default|${storedSessionId}`,
    ...rest
  })

  it('takes one hold per held record, and gives it back when the record goes', async () => {
    const { $sessionTiles, saveSessionTiles } = await import('@/store/session-states')

    $sessionTiles.set([])
    saveSessionTiles([tab('conn-b', 'one'), tab('conn-b', 'two')] as never)
    await vi.advanceTimersByTimeAsync(0)

    expect(connectionHoldCount('conn-b')).toBe(2)
    expect(connect).toHaveBeenCalledTimes(1)

    // A REBIND — the same records committed again — is no change in presence.
    saveSessionTiles([tab('conn-b', 'one'), tab('conn-b', 'two')] as never)
    expect(connectionHoldCount('conn-b')).toBe(2)

    saveSessionTiles([tab('conn-b', 'one')] as never)
    expect(connectionHoldCount('conn-b')).toBe(1)

    // The last record leaves: the socket demotes and the pin goes with it.
    saveSessionTiles([] as never)
    expect(connectionHoldCount('conn-b')).toBe(0)
    expect(__testing.isPinned('conn:conn-b::default')).toBe(false)
  })

  it('gives the hold back when a tab goes unavailable, without closing it', async () => {
    const { $sessionTiles, saveSessionTiles } = await import('@/store/session-states')

    $sessionTiles.set([])
    saveSessionTiles([tab('conn-b', 'one')] as never)
    await vi.advanceTimersByTimeAsync(0)

    expect(connectionHoldCount('conn-b')).toBe(1)

    // Its backend changed under it: it will never use that connection again, so
    // it must not go on pinning it.
    saveSessionTiles([tab('conn-b', 'one', { unavailable: true })] as never)

    expect(connectionHoldCount('conn-b')).toBe(0)
    expect(closeClient).not.toHaveBeenCalled()
  })
})

/**
 * MJXHRM-591 invariant 51 (Design v1.3, N3) — a phase may not outlive its hold.
 *
 * Asserted at the SEAM, not as a property: the settle of a dial whose hold has
 * since been given back must publish nothing, or the app shows a banner for a
 * connection nothing is holding and no tab can clear.
 */
describe('invariant 51 — the settle checks its hold is still the live one', () => {
  it('publishes no phase for a hold that was released while its dial was in flight', async () => {
    let land = (_value: { baseUrl: string }) => {}

    invoke.mockReturnValue(new Promise<{ baseUrl: string }>(resolve => (land = resolve)))

    const taken = holdConnectionClient('conn-b', { ambient: false })!

    expect(connectionClientState('conn-b')).toMatchObject({ phase: 'opening' })

    // The tab closes while the socket is still opening.
    releaseConnectionClient(taken)
    expect($connectionClients.get()['conn-b']).toBeUndefined()

    land({ baseUrl: 'https://gw.test' })
    await vi.advanceTimersByTimeAsync(0)

    // …and the settle that lands afterwards says nothing at all.
    expect($connectionClients.get()['conn-b']).toBeUndefined()
  })
})
