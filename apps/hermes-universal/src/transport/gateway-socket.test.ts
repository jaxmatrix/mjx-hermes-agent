import { beforeEach, describe, expect, it, vi } from 'vitest'

// The seam between desktop's gateway client and the Rust transport. What is
// under test is the bookkeeping the client cannot see: which connection a URL
// is dialled under, and that a tunnel lease lives exactly as long as its socket.
//
// The Tauri surface is faked at the module boundary (`terminal-socket.test.ts`'s
// shape): `invoke` records its arguments, `listen` hands back the callback so a
// test can speak as Rust. The tunnel store is faked whole — it is reached by a
// dynamic import, which `vi.mock` covers the same way.

const { acquireMock, invokeMock, leases, listenMock, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>()

  interface FakeLease {
    base: string
    changed: Set<(descriptor: { generation: number }) => void>
    closed: Set<() => void>
    release: ReturnType<typeof vi.fn>
  }

  const leases: FakeLease[] = []

  return {
    acquireMock: vi.fn(async (connectionId: string) => {
      const lease: FakeLease = { base: 'ws://127.0.0.1:4100', changed: new Set(), closed: new Set(), release: vi.fn() }

      leases.push(lease)

      return {
        connectionId,
        generation: () => 1,
        onChange(handler: (descriptor: { generation: number }) => void) {
          lease.changed.add(handler)

          return () => lease.changed.delete(handler)
        },
        onClosed(handler: () => void) {
          lease.closed.add(handler)

          return () => lease.closed.delete(handler)
        },
        release: lease.release,
        wsUrl: () => `${lease.base}/api/ws`
      }
    }),
    invokeMock: vi.fn(async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => undefined),
    leases,
    listenMock: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
      listeners.set(name, cb)

      return () => {}
    }),
    listeners
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

vi.mock('@/store/connection-tunnels', () => ({ acquireTunnel: acquireMock }))

import { HermesGateway as DesktopGateway } from '@/api/client'
import { HermesGateway } from '@/hermes'

import { __testing, openGatewaySocket, recordGatewayMint } from './gateway-socket'

const REMOTE = 'wss://gw.test/api/ws'
const TUNNEL = 'ws://127.0.0.1:4100/api/ws'

/** The `ws_open` arguments, once the socket's async init has reached Rust. */
async function opened(count = 1): Promise<Record<string, unknown>[]> {
  const calls = () => invokeMock.mock.calls.filter(([command]) => command === 'ws_open')

  await vi.waitFor(() => expect(calls()).toHaveLength(count))

  return calls().map(([, args]) => args as Record<string, unknown>)
}

/** Speak as Rust on the socket `ws_open` was called for. */
function emit(id: unknown, kind: 'close' | 'error' | 'open', payload?: unknown): void {
  listeners.get(`ws://${String(id)}/${kind}`)?.({ payload })
}

function closeCodes(socket: WebSocket): (number | undefined)[] {
  const codes: (number | undefined)[] = []

  socket.addEventListener('close', event => void codes.push(event.code))

  return codes
}

beforeEach(() => {
  __testing.reset()
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  acquireMock.mockClear()
  listenMock.mockClear()
  listeners.clear()
  leases.length = 0
})

describe('the mint ledger', () => {
  it('opens a minted URL under its connection', async () => {
    recordGatewayMint(REMOTE, { connectionId: 'conn-a' })
    openGatewaySocket(REMOTE)

    expect(await opened()).toEqual([expect.objectContaining({ connectionId: 'conn-a', url: REMOTE })])
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it('opens a URL nothing minted with no connection', async () => {
    openGatewaySocket(REMOTE)

    expect(await opened()).toEqual([expect.objectContaining({ connectionId: null, url: REMOTE })])
  })

  it('keeps an entry across dials: a reconnect re-dials the URL it was given', async () => {
    recordGatewayMint(REMOTE, { connectionId: 'conn-a' })
    recordGatewayMint(REMOTE, { connectionId: 'conn-a' })
    openGatewaySocket(REMOTE)
    openGatewaySocket(REMOTE)

    expect((await opened(2)).map(args => args.connectionId)).toEqual(['conn-a', 'conn-a'])
    expect(__testing.mintCount()).toBe(1)
  })

  it('lets the latest mint of a URL win', async () => {
    recordGatewayMint(REMOTE, { connectionId: 'conn-a' })
    recordGatewayMint(REMOTE, { connectionId: 'conn-b' })
    openGatewaySocket(REMOTE)

    expect((await opened())[0].connectionId).toBe('conn-b')
  })

  it('drops the least recently dialled entry past the bound', async () => {
    recordGatewayMint(REMOTE, { connectionId: 'conn-a' })
    recordGatewayMint('wss://other.test/api/ws', { connectionId: 'conn-b' })
    // A dial makes REMOTE the most recent, so the other URL is the oldest.
    openGatewaySocket(REMOTE)
    await opened()

    for (let index = 0; index < 99; index += 1) {
      recordGatewayMint(`wss://gw.test/api/ws?ticket=${index}`, { connectionId: 'conn-c' })
    }

    expect(__testing.mintCount()).toBe(100)

    invokeMock.mockClear()
    openGatewaySocket(REMOTE)
    openGatewaySocket('wss://other.test/api/ws')

    expect((await opened(2)).map(args => args.connectionId)).toEqual(['conn-a', null])
  })
})

describe('a tunnelled socket', () => {
  beforeEach(() => recordGatewayMint(TUNNEL, { connectionId: 'ssh-1', label: 'Build box', tunnel: true }))

  it('dials the lease it holds, under its connection', async () => {
    const socket = openGatewaySocket(TUNNEL)
    const [args] = await opened()

    expect(acquireMock).toHaveBeenCalledExactlyOnceWith('ssh-1', { label: 'Build box' })
    expect(args).toEqual(expect.objectContaining({ connectionId: 'ssh-1', url: TUNNEL }))

    emit(args.id, 'open')

    expect(socket.readyState).toBe(1)
    expect(leases[0].release).not.toHaveBeenCalled()
  })

  it('dials where the tunnel is now, not where it was minted', async () => {
    recordGatewayMint(`${TUNNEL}?profile=work`, { connectionId: 'ssh-1', tunnel: true })
    acquireMock.mockImplementationOnce(async connectionId => {
      const lease = await acquireMock.getMockImplementation()!(connectionId)

      leases[0].base = 'ws://127.0.0.1:4200'

      return lease
    })
    openGatewaySocket(`${TUNNEL}?profile=work`)

    expect((await opened())[0].url).toBe('ws://127.0.0.1:4200/api/ws?profile=work')
  })

  it('releases once on a server close, and keeps the code', async () => {
    const socket = openGatewaySocket(TUNNEL)
    const codes = closeCodes(socket)
    const [args] = await opened()

    emit(args.id, 'open')
    emit(args.id, 'close', { code: 4401, reason: 'unauthorized' })
    socket.close()

    expect(codes).toEqual([4401])
    expect(socket.readyState).toBe(3)
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('releases once on a local close', async () => {
    const socket = openGatewaySocket(TUNNEL)
    const [args] = await opened()

    emit(args.id, 'open')
    socket.close()
    socket.close()

    expect(invokeMock).toHaveBeenCalledWith('ws_close', { id: args.id })
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  // The supervisor tells a refused credential from a drop by `lastCloseCode`.
  it('releases at once on an error, and lets the close that follows keep its code', async () => {
    const socket = openGatewaySocket(TUNNEL)
    const codes = closeCodes(socket)
    const errors = vi.fn()

    socket.addEventListener('error', errors)

    const [args] = await opened()

    emit(args.id, 'error', 'connection reset')

    // A broken socket holds no tunnel — and has not said `close` yet.
    expect(leases[0].release).toHaveBeenCalledTimes(1)
    expect(codes).toEqual([])

    emit(args.id, 'close', { code: 4401, reason: 'unauthorized' })
    socket.close()

    expect(errors).toHaveBeenCalledTimes(1)
    expect(codes).toEqual([4401])
    expect(socket.readyState).toBe(3)
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('says one code-less close when it is closed between an error and its close', async () => {
    const socket = openGatewaySocket(TUNNEL)
    const codes = closeCodes(socket)
    const [args] = await opened()

    emit(args.id, 'error', 'connection reset')
    socket.close()
    emit(args.id, 'close', { code: 4401 })

    expect(codes).toEqual([undefined])
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  // The shared client learns of a death from `close` alone (`json-rpc-gateway`):
  // a transport `close` that never follows its `error` would strand it.
  it("says the one code-less close itself when the transport's never follows its error", async () => {
    const socket = openGatewaySocket(TUNNEL)
    const codes = closeCodes(socket)
    const [args] = await opened()

    vi.useFakeTimers()

    try {
      emit(args.id, 'error', 'connection reset')
      vi.advanceTimersByTime(1_999)

      expect(codes).toEqual([])
      expect(invokeMock).not.toHaveBeenCalledWith('ws_close', expect.anything())

      vi.advanceTimersByTime(1)

      expect(codes).toEqual([undefined])
      expect(socket.readyState).toBe(3)
      expect(invokeMock).toHaveBeenCalledWith('ws_close', { id: args.id })

      // Late, and nobody's any more: one close, one release.
      emit(args.id, 'close', { code: 4401 })
      vi.advanceTimersByTime(10_000)

      expect(codes).toEqual([undefined])
      expect(leases[0].release).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not say a second close once the real one arrived in time', async () => {
    const socket = openGatewaySocket(TUNNEL)
    const codes = closeCodes(socket)
    const [args] = await opened()

    vi.useFakeTimers()

    try {
      emit(args.id, 'error', 'connection reset')
      emit(args.id, 'close', { code: 4401 })
      vi.advanceTimersByTime(10_000)

      expect(codes).toEqual([4401])
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases once when the connect never opens', async () => {
    invokeMock.mockImplementation(async command => {
      if (command === 'ws_open') {
        throw new Error('connection refused')
      }
    })

    const socket = openGatewaySocket(TUNNEL)
    const codes = closeCodes(socket)

    await vi.waitFor(() => expect(codes).toHaveLength(1))

    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('releases a lease that arrives after the socket was closed, and never dials', async () => {
    let arrive: () => void = () => {}
    const original = acquireMock.getMockImplementation()!

    acquireMock.mockImplementationOnce(async connectionId => {
      await new Promise<void>(resolve => (arrive = resolve))

      return original(connectionId)
    })

    const socket = openGatewaySocket(TUNNEL)

    await vi.waitFor(() => expect(acquireMock).toHaveBeenCalled())
    socket.close()
    arrive()

    await vi.waitFor(() => expect(leases[0]?.release).toHaveBeenCalledTimes(1))
    expect(invokeMock).not.toHaveBeenCalledWith('ws_open', expect.anything())
  })

  it('fails closed, holding nothing, when the tunnel cannot be had', async () => {
    acquireMock.mockRejectedValueOnce({ kind: 'credentials-needed', message: 'user@build.internal', terminal: true })

    const socket = openGatewaySocket(TUNNEL)
    const codes = closeCodes(socket)
    const errors: (string | undefined)[] = []

    socket.addEventListener('error', event => void errors.push((event as unknown as { message?: string }).message))

    await vi.waitFor(() => expect(codes).toEqual([undefined]))

    expect(errors).toEqual(['tunnel unavailable'])
    expect(leases).toHaveLength(0)
    expect(invokeMock).not.toHaveBeenCalledWith('ws_open', expect.anything())
  })

  it('ends when the tunnel moves to a later generation, not on its own dial', async () => {
    const socket = openGatewaySocket(TUNNEL)
    const codes = closeCodes(socket)
    const [args] = await opened()

    emit(args.id, 'open')

    for (const handler of [...leases[0].changed]) {
      handler({ generation: 1 })
    }

    expect(codes).toEqual([])

    for (const handler of [...leases[0].changed]) {
      handler({ generation: 2 })
    }

    expect(codes).toEqual([undefined])
    expect(invokeMock).toHaveBeenCalledWith('ws_close', { id: args.id })
    expect(leases[0].release).toHaveBeenCalledTimes(1)
    expect(leases[0].changed.size + leases[0].closed.size).toBe(0)
  })

  it('ends when the tunnel no longer serves the lease', async () => {
    const socket = openGatewaySocket(TUNNEL)
    const codes = closeCodes(socket)
    const [args] = await opened()

    emit(args.id, 'open')

    for (const handler of [...leases[0].closed]) {
      handler()
    }

    expect(codes).toEqual([undefined])
    expect(invokeMock).toHaveBeenCalledWith('ws_close', { id: args.id })
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })
})

describe('HermesGateway', () => {
  it("is desktop's client, option for option", () => {
    const options = (gateway: object) => {
      const { createRequestId, onSocketClose, socketFactory, ...rest } = (
        gateway as unknown as { options: Record<string, unknown> & { createRequestId: (next: number) => unknown } }
      ).options

      void onSocketClose
      void socketFactory

      return { ...rest, requestId: createRequestId(7) }
    }

    expect(options(new HermesGateway())).toEqual(options(new DesktopGateway()))
  })

  it('dials through the seam and keeps the close code of a refused credential', async () => {
    recordGatewayMint(REMOTE, { connectionId: 'conn-a' })

    const gateway = new HermesGateway()
    const connecting = gateway.connect(REMOTE)
    const [args] = await opened()

    expect(args.connectionId).toBe('conn-a')

    emit(args.id, 'close', { code: 4401, reason: 'unauthorized' })

    await expect(connecting).rejects.toThrow('Could not connect to Hermes gateway')
    expect(gateway.lastCloseCode).toBe(4401)
    expect(gateway.connectionState).toBe('closed')
  })

  describe('names the profile its URL was minted for', () => {
    /** Connect to `wsUrl`, send each request, and read the frames Rust was handed. */
    async function sent(wsUrl: string, requests: [method: string, params?: Record<string, unknown>][]) {
      const gateway = new HermesGateway()
      const connecting = gateway.connect(wsUrl)
      const [args] = await opened()

      emit(args.id, 'open')
      await connecting

      for (const [method, params] of requests) {
        void gateway.request(method, params).catch(() => undefined)
      }

      gateway.close()

      return invokeMock.mock.calls
        .filter(([command]) => command === 'ws_send')
        .map(([, frame]) => JSON.parse(String(frame?.text)) as { method: string; params: Record<string, unknown> })
        .map(({ method, params }) => [method, params])
    }

    it('on a method whose contract declares it', async () => {
      expect(await sent(`${REMOTE}?profile=work`, [['session.list', { limit: 5 }], ['config.get']])).toEqual([
        ['session.list', { limit: 5, profile: 'work' }],
        ['config.get', { profile: 'work' }]
      ])
    })

    it('never on a method that does not: the backend answers 4000', async () => {
      expect(await sent(`${REMOTE}?profile=work`, [['reload.env'], ['complete.slash', { text: '/m' }]])).toEqual([
        ['reload.env', {}],
        ['complete.slash', { text: '/m' }]
      ])
    })

    it("keeps the caller's profile, and drops one the registry stamped where none is declared", async () => {
      expect(
        await sent(`${REMOTE}?profile=work`, [
          ['session.list', { profile: 'other' }],
          ['reload.env', { profile: 'other' }],
          ['plugin.method', { profile: 'other' }]
        ])
      ).toEqual([
        ['session.list', { profile: 'other' }],
        ['reload.env', {}],
        ['plugin.method', { profile: 'other' }]
      ])
    })

    it('names none for the launch profile, whose URL is as minted', async () => {
      expect(await sent(REMOTE, [['session.list', { limit: 5 }]])).toEqual([['session.list', { limit: 5 }]])
    })

    it("dials a tunnel with the profile still on the lease's URL", async () => {
      recordGatewayMint(`${TUNNEL}?profile=work`, { connectionId: 'box', tunnel: true })

      expect(await sent(`${TUNNEL}?profile=work`, [['session.list']])).toEqual([['session.list', { profile: 'work' }]])
      expect((await opened())[0]).toMatchObject({ connectionId: 'box', url: `${TUNNEL}?profile=work` })
    })
  })

  it('reads a dropped connection as no code', async () => {
    const gateway = new HermesGateway()
    const connecting = gateway.connect(REMOTE)
    const [args] = await opened()

    emit(args.id, 'open')
    await connecting
    emit(args.id, 'close', { code: null, reason: null })

    expect(gateway.lastCloseCode).toBeUndefined()
    expect(gateway.connectionState).toBe('closed')
  })
})
