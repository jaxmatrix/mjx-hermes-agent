import { isGatewayReauthRequired, resolveGatewayWsUrl } from '@hermes/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The bridge's connection half, as desktop's registry and boot hook see it:
// the descriptor shapes they read, the three strings they classify by text, and
// the bookkeeping they cannot see — every URL a gateway may dial is recorded
// for the socket seam, and a tunnel is held only for the length of a mint.
//
// Rust is faked at the module boundary (`gateway-socket.test.ts`'s shape) and
// the stores the half reaches by dynamic import are faked whole.

const { acquireMock, active, invokeMock, leases, mintTicketMock, rows } = vi.hoisted(() => {
  const leases: { release: ReturnType<typeof vi.fn> }[] = []
  const rows = new Map<string, Record<string, unknown>>()

  return {
    acquireMock: vi.fn(async (connectionId: string, _options?: { label?: string }) => {
      const lease = { release: vi.fn() }

      leases.push(lease)

      return {
        baseUrl: () => 'http://127.0.0.1:4100',
        connectionId,
        release: lease.release,
        wsUrl: () => 'ws://127.0.0.1:4100/api/ws'
      }
    }),
    active: { current: null as null | { connection: Record<string, unknown>; connectionId: string } },
    invokeMock: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (command !== 'connections_resolve') {
        return undefined
      }

      const row = rows.get(String(args?.connectionId))

      if (!row) {
        throw { kind: 'not-found', message: `no gateway with id "${String(args?.connectionId)}"` }
      }

      return row
    }),
    leases,
    mintTicketMock: vi.fn(async (_base: string): Promise<string> => 'TICKET'),
    rows
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'linux' }))
vi.mock('@/lib/auth', () => ({ mintWsTicket: mintTicketMock }))
vi.mock('@/store/active-connection', () => ({ $activeConnection: { get: () => active.current } }))
vi.mock('@/store/connection-tunnels', () => ({ acquireTunnel: acquireMock }))
vi.mock('@/transport/gateway-socket', () => ({ recordGatewayMint: vi.fn() }))

import { GatewayReauthRequiredError } from '@/gateway'
import { TRANSLATIONS } from '@/i18n/catalog'
import { recordGatewayMint } from '@/transport/gateway-socket'

import { connectionBridge as bridge } from './connections'

import { installHermesDesktopBridge } from '.'

const recorded = vi.mocked(recordGatewayMint)

function mintedFor(wsUrl: string) {
  return recorded.mock.calls.find(([url]) => url === wsUrl)?.[1]
}

function activate(connectionId: string, connection: Record<string, unknown> = {}): void {
  active.current = { connection: { authMode: 'none', baseUrl: 'https://live.test', ...connection }, connectionId }
}

beforeEach(() => {
  vi.clearAllMocks()
  acquireMock.mockReset()
  mintTicketMock.mockReset()
  leases.length = 0
  rows.clear()
  active.current = null

  rows.set('home', { authMode: 'token', baseUrl: 'https://home.test', kind: 'remote', label: 'Home' })
  rows.set('cloud', { authMode: 'oauth', baseUrl: 'https://cloud.test', kind: 'cloud', label: 'Cloud' })
  rows.set('box', { kind: 'ssh', label: 'Box', remoteHost: 'me@box' })
  rows.set('local', { kind: 'local', label: 'This device' })
})

describe('the primary', () => {
  it('is the connection this window is on, with no token and its URL recorded', async () => {
    activate('home')

    const conn = await bridge.getConnection()

    expect(conn).toMatchObject({
      authMode: 'token',
      baseUrl: 'https://home.test',
      connectionId: 'home',
      mode: 'remote',
      remoteKind: 'url',
      token: '',
      wsUrl: 'wss://home.test/api/ws'
    })
    expect(conn.profile).toBeUndefined()
    expect(conn.sharedPrimary).toBeUndefined()
    expect(mintedFor(conn.wsUrl)).toEqual({ connectionId: 'home' })
  })

  it("serves another profile on its own socket: 'sharedPrimary', never a second dial", async () => {
    activate('home')

    expect(await bridge.getConnection('work')).toMatchObject({ connectionId: 'home', profile: 'work', sharedPrimary: true })
    expect((await bridge.getConnection('default')).sharedPrimary).toBeUndefined()
  })

  it("launches as 'default', so an RPC naming no profile is already correct", async () => {
    expect(await bridge.profile.get()).toEqual({ profile: 'default' })
  })

  it('rejects when the window is on no connection', async () => {
    await expect(bridge.getConnection()).rejects.toThrow('Not connected to a Hermes backend')
    expect(await bridge.getBootProgress()).toMatchObject({ error: 'Not connected to a Hermes backend', retryable: false })
  })

  it('dials its live descriptor while the registry has no row for it yet', async () => {
    activate('https://early.test', { authMode: 'token', baseUrl: 'https://early.test', token: 'T' })

    const conn = await bridge.getConnection()

    expect(conn).toMatchObject({ baseUrl: 'https://early.test', token: '', wsUrl: 'wss://early.test/api/ws?token=T' })
    expect(mintedFor(conn.wsUrl)).toEqual({ connectionId: 'https://early.test' })
  })

  it('reports the backend ready once it resolves', async () => {
    activate('home')
    await bridge.getConnection()

    expect(await bridge.getBootProgress()).toMatchObject({ error: null, phase: 'backend.ready', running: true })
  })
})

describe('a registered connection', () => {
  it("resolves (connection, profile) as a registry route on the connection's one backend", async () => {
    activate('home')

    const conn = await bridge.getConnectionFor({ connectionId: 'cloud', profile: 'work' })

    expect(conn).toMatchObject({
      authMode: 'oauth',
      connectionId: 'cloud',
      profile: 'work',
      registryScoped: true,
      remoteKind: 'cloud',
      sharedRemote: true,
      token: ''
    })
    expect(mintedFor(conn.wsUrl)).toEqual({ connectionId: 'cloud' })
  })

  it('treats an empty id as the primary', async () => {
    activate('home')

    expect(await bridge.getConnectionFor({ connectionId: '', profile: null })).toMatchObject({
      connectionId: 'home',
      profile: 'default'
    })
  })

  it('fails a removed connection in the words the registry fail-stops on', async () => {
    activate('home')

    await expect(bridge.getConnectionFor({ connectionId: 'gone', profile: 'default' })).rejects.toThrow(
      'No connection with id "gone"'
    )
  })
})

describe('a local or SSH connection', () => {
  it('takes the tunnel at mint time, records the tunnel mint, and lets go', async () => {
    activate('home')

    const conn = await bridge.getConnectionFor({ connectionId: 'box', profile: 'default' })

    expect(acquireMock).toHaveBeenCalledWith('box', { label: 'Box' })
    expect(leases).toHaveLength(1)
    expect(leases[0].release).toHaveBeenCalledTimes(1)
    expect(conn).toMatchObject({
      baseUrl: 'http://127.0.0.1:4100',
      mode: 'remote',
      remoteHost: 'me@box',
      remoteKind: 'ssh',
      token: '',
      wsUrl: 'ws://127.0.0.1:4100/api/ws'
    })
    expect(mintedFor(conn.wsUrl)).toEqual({ connectionId: 'box', label: 'Box', tunnel: true })
  })

  it('warms the tunnel again for a re-mint', async () => {
    activate('home')

    expect(await bridge.getGatewayWsUrlFor({ connectionId: 'local', profile: 'default' })).toEqual({
      ok: true,
      wsUrl: 'ws://127.0.0.1:4100/api/ws'
    })
    expect(leases[0].release).toHaveBeenCalledTimes(1)
    expect(mintedFor('ws://127.0.0.1:4100/api/ws')).toMatchObject({ connectionId: 'local', tunnel: true })
  })

  it("is 'local' only when it is this device", async () => {
    activate('local')

    expect(await bridge.getConnection()).toMatchObject({ connectionId: 'local', mode: 'local' })
  })

  it('reports a tunnel failure as copy, never as the text Rust gave', async () => {
    activate('box')
    acquireMock.mockRejectedValueOnce({ kind: 'credentials-needed', message: 'me@box.internal refused', terminal: true })

    await expect(bridge.getConnection()).rejects.toThrow(TRANSLATIONS.en.settings.gateway.sshErrAuth)
    expect(await bridge.getBootProgress()).toMatchObject({ retryable: false })
  })

  it('marks a transient tunnel failure retryable for the boot hook', async () => {
    activate('box')
    acquireMock.mockRejectedValueOnce({ kind: 'transient', message: 'timed out', terminal: false })

    await expect(bridge.getConnection()).rejects.toBeInstanceOf(Error)
    expect(await bridge.getBootProgress()).toMatchObject({ retryable: true, running: false })
  })
})

describe('a fresh WebSocket URL', () => {
  it('is the recorded ticketless URL for a token connection', async () => {
    activate('home')

    expect(await bridge.getGatewayWsUrl('work')).toEqual({ ok: true, wsUrl: 'wss://home.test/api/ws' })
    expect(mintTicketMock).not.toHaveBeenCalled()
    expect(mintedFor('wss://home.test/api/ws')).toEqual({ connectionId: 'home' })
  })

  it('carries a single-use ticket for a gated connection, recorded like any other', async () => {
    activate('home')

    const result = await bridge.getGatewayWsUrlFor({ connectionId: 'cloud', profile: 'default' })

    expect(result).toEqual({ ok: true, wsUrl: 'wss://cloud.test/api/ws?ticket=TICKET' })
    expect(mintTicketMock).toHaveBeenCalledWith('https://cloud.test')
    expect(mintedFor('wss://cloud.test/api/ws?ticket=TICKET')).toEqual({ connectionId: 'cloud' })
  })

  it('trusts the live probe over a saved row that predates the gate', async () => {
    activate('home', { authMode: 'oauth', baseUrl: 'https://home.test' })

    expect((await bridge.getConnection()).authMode).toBe('oauth')
    expect(await bridge.getGatewayWsUrl()).toEqual({ ok: true, wsUrl: 'wss://home.test/api/ws?ticket=TICKET' })
  })

  it("answers an expired session with 'needsOauthLogin', which the shared resolver raises as reauth", async () => {
    activate('cloud')
    mintTicketMock.mockRejectedValue(new GatewayReauthRequiredError('Session expired — sign in again'))

    const result = await bridge.getGatewayWsUrl()

    expect(result).toMatchObject({ needsOauthLogin: true, ok: false })

    const failure = await resolveGatewayWsUrl(bridge, await bridge.getConnection()).catch((error: unknown) => error)

    expect(isGatewayReauthRequired(failure)).toBe(true)
  })

  it('keeps a transport failure out of the answer', async () => {
    activate('cloud')
    mintTicketMock.mockRejectedValue('error sending request for url (https://cloud.test/api/auth/ws-ticket)')

    expect(await bridge.getGatewayWsUrl()).toEqual({ error: 'Could not refresh the gateway WebSocket ticket', ok: false })
  })

  it('answers a removed connection rather than rejecting', async () => {
    activate('home')

    expect(await bridge.getGatewayWsUrlFor({ connectionId: 'gone', profile: 'default' })).toEqual({
      error: 'No connection with id "gone"',
      ok: false
    })
  })
})

describe('signals with no universal source', () => {
  it('subscribe and never fire', () => {
    const callback = vi.fn()

    bridge.onBootProgress(callback)()
    bridge.onBackendExit(callback)()

    expect(callback).not.toHaveBeenCalled()
  })

  it('offer no power-resume on a desktop, where becoming visible is not a resume', () => {
    expect(bridge.onPowerResume).toBeUndefined()
  })
})

describe('the installed bridge', () => {
  it('carries the connection half, and leaves what is not implemented absent', () => {
    installHermesDesktopBridge()

    const installed = window.hermesDesktop as unknown as Record<string, unknown>

    for (const member of ['getConnection', 'getConnectionFor', 'getGatewayWsUrl', 'getGatewayWsUrlFor', 'getBootProgress']) {
      expect(installed[member]).toBe((bridge as Record<string, unknown>)[member])
    }

    // Feature-detected by the boot hook and the registry; a fake would be believed.
    for (const member of ['connections', 'onConnectionApplied', 'revalidateConnection', 'setActiveConnectionRoute']) {
      expect(installed[member]).toBeUndefined()
    }
  })
})
