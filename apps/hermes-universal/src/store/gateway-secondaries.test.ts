import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  acquireTunnel,
  connect,
  invoke,
  onAny,
  request,
  close: closeClient,
  sockets
} = vi.hoisted(() => ({
  acquireTunnel: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(async (_url: string) => {}),
  invoke: vi.fn(),
  onAny: vi.fn(),
  request: vi.fn(async () => 'ok'),
  sockets: [] as { url: string; options: unknown }[]
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/store/connection-tunnels', () => ({
  acquireTunnel,
  setTunnelAnswerSaver: vi.fn(() => () => {})
}))
vi.mock('@/store/session-route-dispatch', () => ({
  SessionRouteError: class extends Error {
    constructor(
      readonly kind: string,
      readonly scopeKey: string
    ) {
      super(`session route unavailable (${kind})`)
    }
  }
}))
vi.mock('@/transport/tauri-websocket', () => ({
  TauriWebSocket: class {
    constructor(url: string, options: unknown) {
      sockets.push({ options, url })
    }
  }
}))
vi.mock('@/gateway', () => ({
  JsonRpcGatewayClient: class {
    close = closeClient
    connect = async (url: string) => {
      this.factory(url)
      await connect(url)
    }
    onAny = onAny
    request = request
    factory: (url: string) => unknown

    constructor(options: { socketFactory: (url: string) => unknown }) {
      this.factory = options.socketFactory
    }
  }
}))

import {
  __testing,
  addConnectionEventListener,
  closeAllSecondaries,
  IDLE_REAP_MS,
  leaseSecondary,
  MAX_SECONDARIES,
  releaseParkedTunnels,
  releaseSecondary
} from './gateway-secondaries'

function fakeTunnel() {
  const changed: ((next: { generation: number }) => void)[] = []
  const closed: (() => void)[] = []
  const release = vi.fn()

  const lease = {
    baseUrl: () => 'http://127.0.0.1:41000',
    connectionId: 'ssh1',
    generation: () => 1,
    instanceKey: 'ssh:deploy@box:22',
    onChange: (handler: (next: { generation: number }) => void) => {
      changed.push(handler)

      return () => changed.splice(changed.indexOf(handler), 1)
    },
    onClosed: (handler: () => void) => {
      closed.push(handler)

      return () => closed.splice(closed.indexOf(handler), 1)
    },
    release,
    wsUrl: () => 'ws://127.0.0.1:41000/api/ws'
  }

  return { changed, closed, lease, release }
}

beforeEach(() => {
  vi.useFakeTimers()
  __testing.reset()

  for (const spy of [acquireTunnel, connect, invoke, onAny, request, closeClient]) {
    spy.mockClear()
  }

  sockets.length = 0

  invoke.mockResolvedValue({ baseUrl: 'https://gw.test' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('leaseSecondary', () => {
  it('reuses one socket per scope', async () => {
    await leaseSecondary('conn:a::default', 'a')
    await leaseSecondary('conn:a::default', 'a')

    expect(connect).toHaveBeenCalledTimes(1)
    expect(__testing.liveScopeKeys()).toEqual(['conn:a::default'])
  })

  it('caps at five and evicts the least recently used', async () => {
    // A 445 room with six members on six profiles of one connection needs FIVE
    // distinct leases (dispatch short-circuits only on the active scope), so a
    // cap of four would evict a member mid-round (reconciliation A11).
    expect(MAX_SECONDARIES).toBe(5)

    for (let n = 0; n < MAX_SECONDARIES; n += 1) {
      await leaseSecondary(`conn:a::p${n}`, 'a')
      vi.advanceTimersByTime(1)
    }

    await leaseSecondary('conn:a::p9', 'a')

    const live = __testing.liveScopeKeys()

    expect(live).toHaveLength(MAX_SECONDARIES)
    expect(live).not.toContain('conn:a::p0')
    expect(live).toContain('conn:a::p9')
  })

  it('reaps an idle socket, because Rust never reconnects one', async () => {
    const lease = await leaseSecondary('conn:a::default', 'a')

    releaseSecondary(lease)
    vi.advanceTimersByTime(IDLE_REAP_MS + 1)

    expect(closeClient).toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).toEqual([])
  })

  it('refuses a source with no addressable URL rather than inventing one', async () => {
    invoke.mockResolvedValue({ kind: 'remote' })

    await expect(leaseSecondary('conn:odd::default', 'odd')).rejects.toThrow(/no addressable gateway/)
    expect(acquireTunnel).not.toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).toEqual([])
  })

  it('reaches an ssh source through its tunnel, and lets the tunnel go on close', async () => {
    const { changed, lease, release } = fakeTunnel()

    invoke.mockResolvedValue({ kind: 'ssh', label: 'Box' })
    acquireTunnel.mockResolvedValue(lease)

    await leaseSecondary('conn:ssh1::default', 'ssh1')

    expect(acquireTunnel).toHaveBeenCalledWith('ssh1', { label: 'Box' })
    // No token in the URL: Rust attaches it for this connection id.
    expect(sockets).toEqual([{ options: { connectionId: 'ssh1' }, url: 'ws://127.0.0.1:41000/api/ws' }])
    expect(release).not.toHaveBeenCalled()

    // The event for the dial this socket rides can land after it: not a redial.
    changed.forEach(handler => handler({ generation: 1 }))
    expect(closeClient).not.toHaveBeenCalled()

    // A redial moved the port: the socket goes, and so does its hold.
    changed.forEach(handler => handler({ generation: 2 }))

    expect(closeClient).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(__testing.liveScopeKeys()).toEqual([])

    await leaseSecondary('conn:ssh1::default', 'ssh1')
    const revision = closeAllSecondaries()

    // A switch keeps the hold until its own dial has adopted the tunnel.
    expect(closeClient).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(1)

    releaseParkedTunnels(revision)

    expect(release).toHaveBeenCalledTimes(2)
  })
})

function deferred<T>() {
  let resolve = (_value: T) => {}

  let reject = (_error: unknown) => {}

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, reject, resolve }
}

// MJXHRM-592: a cold SSH dial takes 45–90 s, so a second lease on the scope
// arrives while the first is still opening.
describe('opening a secondary', () => {
  it('shares one open between concurrent leases', async () => {
    const tunnel = deferred<ReturnType<typeof fakeTunnel>['lease']>()
    const { lease } = fakeTunnel()

    invoke.mockResolvedValue({ kind: 'ssh' })
    acquireTunnel.mockReturnValue(tunnel.promise)

    const first = leaseSecondary('conn:ssh1::default', 'ssh1')
    const second = leaseSecondary('conn:ssh1::default', 'ssh1')

    tunnel.resolve(lease)

    const [one, two] = await Promise.all([first, second])

    expect(acquireTunnel).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    await expect(one.request('session.list')).resolves.toBe('ok')
    await expect(two.request('session.list')).resolves.toBe('ok')
  })

  it('fails every caller together, releases once, and lets the next call start over', async () => {
    const dial = deferred<void>()
    const { lease, release } = fakeTunnel()

    invoke.mockResolvedValue({ kind: 'ssh' })
    acquireTunnel.mockResolvedValue(lease)
    connect.mockImplementationOnce(() => dial.promise)

    const first = leaseSecondary('conn:ssh1::default', 'ssh1')
    const second = leaseSecondary('conn:ssh1::default', 'ssh1')
    const refused = new Error('refused')

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    // Still connecting: not in live, so no lease can reach a half-open socket.
    expect(__testing.liveScopeKeys()).toEqual([])
    dial.reject(refused)

    await expect(first).rejects.toBe(refused)
    await expect(second).rejects.toBe(refused)
    expect(release).toHaveBeenCalledTimes(1)

    await expect(leaseSecondary('conn:ssh1::default', 'ssh1')).resolves.toBeDefined()
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('lets nothing a switch interrupted land in live', async () => {
    const dial = deferred<void>()
    const { lease, release } = fakeTunnel()

    invoke.mockResolvedValue({ kind: 'ssh' })
    acquireTunnel.mockResolvedValue(lease)
    connect.mockImplementationOnce(() => dial.promise)

    const first = leaseSecondary('conn:ssh1::default', 'ssh1')
    const second = leaseSecondary('conn:ssh1::default', 'ssh1')

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    const revision = closeAllSecondaries()
    dial.resolve()

    await expect(first).rejects.toMatchObject({ kind: 'switching' })
    await expect(second).rejects.toMatchObject({ kind: 'switching' })
    expect(__testing.liveScopeKeys()).toEqual([])
    // Parked like any hold a switch closed, not dropped under the new dial.
    expect(release).not.toHaveBeenCalled()
    releaseParkedTunnels(revision)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('parks nothing once the switch that interrupted the open has settled', async () => {
    const tunnel = deferred<ReturnType<typeof fakeTunnel>['lease']>()
    const { lease, release } = fakeTunnel()

    invoke.mockResolvedValue({ kind: 'ssh' })
    acquireTunnel.mockReturnValue(tunnel.promise)

    const opening = leaseSecondary('conn:ssh1::default', 'ssh1')

    await vi.waitFor(() => expect(acquireTunnel).toHaveBeenCalledTimes(1))

    // The switch begins and settles while the tunnel is still being acquired.
    releaseParkedTunnels(closeAllSecondaries())
    tunnel.resolve(lease)

    await expect(opening).rejects.toMatchObject({ kind: 'switching' })
    expect(release).toHaveBeenCalledTimes(1)
    expect(__testing.parkedCount()).toBe(0)
  })

  it("keeps a newer switch's parked hold when an older switch settles", async () => {
    const tunnel = deferred<ReturnType<typeof fakeTunnel>['lease']>()
    const { lease, release } = fakeTunnel()

    invoke.mockResolvedValue({ kind: 'ssh' })
    acquireTunnel.mockReturnValue(tunnel.promise)

    const opening = leaseSecondary('conn:ssh1::default', 'ssh1')

    await vi.waitFor(() => expect(acquireTunnel).toHaveBeenCalledTimes(1))

    const older = closeAllSecondaries()
    const newer = closeAllSecondaries()

    // The older switch settles; the newer is still dialling when the open lands.
    releaseParkedTunnels(older)
    tunnel.resolve(lease)
    await expect(opening).rejects.toMatchObject({ kind: 'switching' })

    expect(release).not.toHaveBeenCalled()
    expect(__testing.parkedCount()).toBe(1)

    // A repeated older settle still leaves the newer switch's hold alone.
    releaseParkedTunnels(older)
    expect(release).not.toHaveBeenCalled()

    releaseParkedTunnels(newer)
    expect(release).toHaveBeenCalledTimes(1)
    expect(__testing.parkedCount()).toBe(0)
  })

  it('never shares an open that a switch has since invalidated', async () => {
    const first = deferred<ReturnType<typeof fakeTunnel>['lease']>()
    const second = deferred<ReturnType<typeof fakeTunnel>['lease']>()
    const stale = fakeTunnel()
    const fresh = fakeTunnel()

    invoke.mockResolvedValue({ kind: 'ssh' })
    acquireTunnel.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const before = leaseSecondary('conn:ssh1::default', 'ssh1')

    await vi.waitFor(() => expect(acquireTunnel).toHaveBeenCalledTimes(1))

    // The switch begins and settles while that open is still dialling.
    releaseParkedTunnels(closeAllSecondaries())

    const after = leaseSecondary('conn:ssh1::default', 'ssh1')

    // Its own open, not the one the switch invalidated.
    await vi.waitFor(() => expect(acquireTunnel).toHaveBeenCalledTimes(2))
    expect(invoke).toHaveBeenCalledTimes(2)

    first.resolve(stale.lease)
    await expect(before).rejects.toMatchObject({ kind: 'switching' })
    expect(stale.release).toHaveBeenCalledTimes(1)

    // The stale open ending leaves the current one in place to be shared.
    const joined = leaseSecondary('conn:ssh1::default', 'ssh1')

    expect(invoke).toHaveBeenCalledTimes(2)

    second.resolve(fresh.lease)

    const [one, two] = await Promise.all([after, joined])

    expect(connect).toHaveBeenCalledTimes(1)
    expect(__testing.liveScopeKeys()).toEqual(['conn:ssh1::default'])
    await expect(one.request('session.list')).resolves.toBe('ok')
    await expect(two.request('session.list')).resolves.toBe('ok')
    expect(fresh.release).not.toHaveBeenCalled()
  })

  it('leaves no open behind a test reset', async () => {
    const resolved = deferred<{ kind: string }>()

    invoke.mockReturnValueOnce(resolved.promise)

    // A previous test's open, still waiting on `connections_resolve`.
    void leaseSecondary('conn:a::default', 'a').catch(() => {})
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

    __testing.reset()

    expect(__testing.openingCount()).toBe(0)

    await leaseSecondary('conn:a::default', 'a')

    expect(invoke).toHaveBeenCalledTimes(2)
    resolved.resolve({ kind: 'remote' })
  })
})

describe('a tunnel that closes', () => {
  it('closes its secondary instead of reusing a dead socket', async () => {
    const { closed, lease, release } = fakeTunnel()

    invoke.mockResolvedValue({ kind: 'ssh' })
    acquireTunnel.mockResolvedValue(lease)

    const held = await leaseSecondary('conn:ssh1::default', 'ssh1')

    closed.forEach(handler => handler())

    expect(__testing.liveScopeKeys()).toEqual([])
    expect(release).toHaveBeenCalledTimes(1)
    expect(closeClient).toHaveBeenCalledTimes(1)

    // A lease still in someone's hands rejects, and arms no reap timer.
    const timers = vi.getTimerCount()

    await expect(held.request('session.list')).rejects.toThrow(/closed/)
    expect(request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(timers)
  })
})

describe('events', () => {
  it('drops an unclaimed foreign event instead of routing it', async () => {
    await leaseSecondary('conn:a::default', 'a')

    const deliver = onAny.mock.calls[0]?.[0] as (event: unknown) => void

    // Nothing registered for 'a': the event goes nowhere. Handing it to the
    // app's own router would put another machine's session id into the active
    // connection's stores (rule 7).
    expect(() => deliver({ type: 'session.event' })).not.toThrow()

    const seen: unknown[] = []
    const off = addConnectionEventListener('a', event => seen.push(event))

    deliver({ type: 'session.event' })
    expect(seen).toHaveLength(1)
    expect((seen[0] as { connectionId: string }).connectionId).toBe('a')

    off()
    deliver({ type: 'session.event' })
    expect(seen).toHaveLength(1)
  })

  it('survives a listener that throws', async () => {
    await leaseSecondary('conn:a::default', 'a')

    const deliver = onAny.mock.calls[0]?.[0] as (event: unknown) => void
    const seen: unknown[] = []

    addConnectionEventListener('a', () => {
      throw new Error('bad plugin')
    })
    addConnectionEventListener('a', event => seen.push(event))

    deliver({ type: 'session.event' })
    expect(seen).toHaveLength(1)
  })
})

describe('closeAllSecondaries', () => {
  it('drops every socket, because they belong to the source being left', async () => {
    await leaseSecondary('conn:a::default', 'a')
    await leaseSecondary('conn:b::default', 'b')

    closeAllSecondaries()

    expect(__testing.liveScopeKeys()).toEqual([])
    expect(closeClient).toHaveBeenCalledTimes(2)
  })
})
