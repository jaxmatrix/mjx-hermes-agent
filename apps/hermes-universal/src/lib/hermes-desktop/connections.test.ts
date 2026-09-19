import { isGatewayReauthRequired, resolveGatewayWsUrl } from '@hermes/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The bridge's connection half, as desktop's registry and boot hook see it:
// the descriptor shapes they read, the three strings they classify by text, and
// the bookkeeping they cannot see — every URL a gateway may dial is recorded
// for the socket seam, and a tunnel is held only for the length of a mint.
//
// Rust is faked at the module boundary (`gateway-socket.test.ts`'s shape) and
// the stores the half reaches by dynamic import are faked whole.

const { acquireMock, active, apiMock, invokeMock, leases, mintTicketMock, rows, windowProfile } = vi.hoisted(() => {
  const leases: { release: ReturnType<typeof vi.fn> }[] = []
  const rows = new Map<string, Record<string, unknown>>()

  return {
    apiMock: vi.fn(async (_request: Record<string, unknown>): Promise<unknown> => ({ ok: true })),
    windowProfile: { current: null as null | string },
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

// The registry store's per-connection profile memory.
const lastProfiles = vi.hoisted(() => new Map<string, string>())

// The boot cookie restore, as the bridge waits on it.
const cookies = vi.hoisted(() => ({ restored: Promise.resolve() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'linux' }))
vi.mock('@/lib/api', () => ({ api: apiMock }))
vi.mock('@/lib/auth', () => ({ mintWsTicket: mintTicketMock }))
vi.mock('@/lib/session-persist', () => ({ sessionCookiesRestored: () => cookies.restored }))
vi.mock('@/store/active-connection', () => ({ $activeConnection: { get: () => active.current } }))
vi.mock('@/store/connection-tunnels', async () => ({
  $tunnelStatus: (await import('nanostores')).map({}),
  acquireTunnel: acquireMock
}))
// The registry store's rows are `connections_resolve`'s, with the id and a `url`,
// and its per-source profile memory, where `default` is not remembered.
vi.mock('@/store/connections', () => ({
  connectionById: (id: string) => {
    const row = rows.get(id)

    return row && { ...row, id, url: row.baseUrl }
  },
  lastProfileFor: (id: string) => {
    const held = lastProfiles.get(id)

    return held && held !== 'default' ? held : null
  },
  rememberProfile: (id: string, profile: string) => void lastProfiles.set(id, profile)
}))
vi.mock('@/store/windows', () => ({ windowProfileOverride: () => windowProfile.current }))
vi.mock('@/transport/gateway-socket', () => ({ recordGatewayMint: vi.fn() }))

import { GatewayReauthRequiredError } from '@/gateway'
import { TRANSLATIONS } from '@/i18n/catalog'
import { $tunnelStatus, type TunnelStatus } from '@/store/connection-tunnels'
import { profileScoped, socketProfile } from '@/transport/gateway-profile'
import { recordGatewayMint } from '@/transport/gateway-socket'

import { emitConnectionApplied } from './connection-applied'
import { connectionBridge as bridge, tunnelBootProgress } from './connections'

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
  cookies.restored = Promise.resolve()
  windowProfile.current = null
  lastProfiles.clear()
  $tunnelStatus.set({})
  // A re-home: the primary's profile is read again.
  emitConnectionApplied()

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

  it('is the profile the window was opened on, whenever the boot hook names none', async () => {
    activate('home')
    windowProfile.current = 'work'

    const conn = await bridge.getConnection()

    expect(conn).toMatchObject({ profile: 'work', wsUrl: 'wss://home.test/api/ws?profile=work' })
    expect(mintedFor(conn.wsUrl)).toEqual({ connectionId: 'home' })
    expect((await bridge.getConnection('default')).wsUrl).toBe('wss://home.test/api/ws')
  })

  it("launches as 'default', so an RPC naming no profile is already correct", async () => {
    expect(await bridge.profile.get()).toEqual({ profile: 'default' })

    activate('home')

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

describe("the primary's profile", () => {
  // `session.create` declares `profile` in the wire contract.
  const stamped = (wsUrl: string) => profileScoped('session.create', {}, socketProfile(wsUrl))

  it('is the one its connection was last used on, remembered per connection', async () => {
    activate('home')

    expect(await bridge.profile.remember('work')).toEqual({ profile: 'work' })
    expect(lastProfiles.get('home')).toBe('work')

    emitConnectionApplied()

    expect(await bridge.profile.get()).toEqual({ profile: 'work' })

    activate('cloud')

    expect(await bridge.profile.get()).toEqual({ profile: 'default' })
  })

  // The registry files the primary under the adopted profile and sends that
  // profile's RPCs bare (`gatewayForProfile` → `scopeProfile: false`), so the
  // socket the hook dials has to name it, or they would run as `default`.
  it('is what the socket the boot hook dials stamps on a bare RPC', async () => {
    lastProfiles.set('home', 'work')
    activate('home')

    const { profile } = await bridge.profile.get()
    const conn = await bridge.getConnection()
    const wsUrl = await resolveGatewayWsUrl(bridge, conn)

    expect(profile).toBe('work')
    expect(conn).toMatchObject({ profile: 'work', sharedPrimary: true, wsUrl: 'wss://home.test/api/ws?profile=work' })
    expect(wsUrl).toBe(conn.wsUrl)
    expect(stamped(wsUrl)).toEqual({ profile })
    expect(await bridge.getGatewayWsUrl()).toEqual({ ok: true, wsUrl })
    expect(mintedFor(wsUrl)).toEqual({ connectionId: 'home' })
  })

  it("serves 'default' as a request scope on a primary that serves another", async () => {
    lastProfiles.set('home', 'work')
    activate('home')

    expect(await bridge.getConnection('default')).toMatchObject({ profile: 'default', sharedPrimary: true })
  })

  it('holds for the life of the primary, and is read again on a re-home', async () => {
    lastProfiles.set('home', 'work')
    activate('home')
    await bridge.getConnection()

    // The rail moved on mid-life: the wake reconnect still dials what the
    // registry filed the primary under.
    await bridge.profile.remember('play')

    expect(socketProfile((await bridge.getConnection()).wsUrl)).toBe('work')

    emitConnectionApplied()

    expect(socketProfile((await bridge.getConnection()).wsUrl)).toBe('play')
  })

  it('gives way to the profile a window was opened on', async () => {
    lastProfiles.set('home', 'work')
    windowProfile.current = 'pinned'
    activate('home')

    expect(await bridge.profile.get()).toEqual({ profile: 'pinned' })
    expect(stamped((await bridge.getConnection()).wsUrl)).toEqual({ profile: 'pinned' })
  })
})

describe('a connection apply', () => {
  it('reaches its subscribers with no payload, until they leave', () => {
    const callback = vi.fn()
    const off = bridge.onConnectionApplied(callback)

    emitConnectionApplied()

    expect(callback.mock.calls).toEqual([[]])

    off()
    emitConnectionApplied()

    expect(callback).toHaveBeenCalledTimes(1)
  })
})

describe('boot progress', () => {
  const status = (partial: Partial<TunnelStatus>): TunnelStatus => ({
    connectionId: 'box',
    generation: 0,
    phase: 'connecting',
    terminal: false,
    ...partial
  })

  const gateway = TRANSLATIONS.en.settings.gateway
  const steps = TRANSLATIONS.en.boot.steps

  it.each([
    [
      'a dial that has not said where it is',
      status({}),
      { error: null, message: steps.startingDesktopConnection, phase: 'backend.resolve', progress: 4, running: true }
    ],
    [
      'an SSH step',
      status({ fraction: 0.15, step: 'authenticating' }),
      { error: null, message: gateway.sshStepAuthenticating, phase: 'backend.resolve', progress: 18, running: true }
    ],
    [
      'the last SSH step, still short of ready',
      status({ fraction: 0.95, step: 'verifying' }),
      { error: null, message: gateway.sshStepVerifying, phase: 'backend.resolve', progress: 90, running: true }
    ],
    [
      'a redial',
      status({ phase: 'retrying' }),
      { error: null, message: steps.retryingRemoteBackend, phase: 'backend.resolve', progress: 4, running: true }
    ],
    [
      'a tunnel that is up',
      status({ phase: 'ready' }),
      { error: null, phase: 'backend.ready', progress: 94, running: true }
    ],
    [
      'a failure retrying can fix',
      status({ errorKind: 'transient', message: 'box:22 unreachable', phase: 'failed' }),
      { error: gateway.sshErrUnknown, phase: 'backend.error', retryable: true, running: false }
    ],
    [
      'a changed host key',
      status({ errorKind: 'host-key-changed', message: 'ssh-keygen -R box', phase: 'failed', terminal: true }),
      { error: gateway.sshErrHostKey, phase: 'backend.error', retryable: false, running: false }
    ],
    [
      'a credential only a person has',
      status({ errorKind: 'credentials-needed', phase: 'failed', terminal: true }),
      { error: gateway.sshErrAuth, phase: 'backend.error', retryable: false, running: false }
    ],
    [
      'a locked device',
      status({ errorKind: 'locked', phase: 'failed', terminal: true }),
      { error: gateway.sshErrLocked, phase: 'backend.error', retryable: false, running: false }
    ]
  ])('maps %s', (_name, from, to) => {
    expect(tunnelBootProgress(from)).toMatchObject({ fakeMode: false, ...to })
  })

  it('has nothing to say about a slot that left', () => {
    expect(tunnelBootProgress(status({ phase: 'closed' }))).toBeNull()
  })

  it("pushes the active connection's tunnel, and nobody else's, until the hook leaves", async () => {
    const callback = vi.fn()

    activate('box')

    const off = bridge.onBootProgress(callback)

    // The watch attaches behind two dynamic imports.
    await vi.waitFor(() => expect($tunnelStatus.lc).toBe(1))

    $tunnelStatus.setKey('local', status({ connectionId: 'local' }))

    expect(callback).not.toHaveBeenCalled()

    $tunnelStatus.setKey('box', status({ fraction: 0.05, step: 'connecting' }))

    expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'backend.resolve', progress: 9 }))
    expect(await bridge.getBootProgress()).toBe(callback.mock.lastCall?.[0])

    off()
    await vi.waitFor(() => expect($tunnelStatus.lc).toBe(0))
  })

  // Rust refuses the background dial of a tunnel that needs a person with the
  // error and the status of the dial that failed. Either way the hook reads a
  // boot error it must not retry.
  it('never lets the boot hook retry a tunnel that needs a person', async () => {
    const callback = vi.fn()
    const refused = { kind: 'host-key-changed', message: 'ssh-keygen -R box', terminal: true }

    activate('box')
    bridge.onBootProgress(callback)
    await vi.waitFor(() => expect($tunnelStatus.lc).toBe(1))

    acquireMock.mockImplementation(async () => {
      $tunnelStatus.setKey(
        'box',
        status({ errorKind: refused.kind, message: refused.message, phase: 'failed', terminal: true })
      )

      throw refused
    })

    await expect(bridge.getConnection()).rejects.toThrow(gateway.sshErrHostKey)

    for (const [pushed] of callback.mock.calls) {
      expect(pushed).toMatchObject({ error: gateway.sshErrHostKey, retryable: false, running: false })
    }

    expect(callback).toHaveBeenCalledTimes(2)
    expect(await bridge.getBootProgress()).toMatchObject({ retryable: false })
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
      token: '',
      // The socket has no profile of its own: the URL tells the client which to name.
      wsUrl: 'wss://cloud.test/api/ws?profile=work'
    })
    expect(mintedFor(conn.wsUrl)).toEqual({ connectionId: 'cloud' })
  })

  it("leaves the launch profile's URL as minted", async () => {
    activate('home')

    expect((await bridge.getConnectionFor({ connectionId: 'cloud', profile: 'default' })).wsUrl).toBe(
      'wss://cloud.test/api/ws'
    )
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

  it("records another profile's URL as the same tunnel mint", async () => {
    activate('home')

    const conn = await bridge.getConnectionFor({ connectionId: 'box', profile: 'work' })

    expect(conn.wsUrl).toBe('ws://127.0.0.1:4100/api/ws?profile=work')
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

    expect(await bridge.getGatewayWsUrl()).toEqual({ ok: true, wsUrl: 'wss://home.test/api/ws' })
    expect(mintTicketMock).not.toHaveBeenCalled()
    expect(mintedFor('wss://home.test/api/ws')).toEqual({ connectionId: 'home' })
  })

  it('names the profile it was asked for, and is recorded under that URL', async () => {
    activate('home')

    expect(await bridge.getGatewayWsUrl('work')).toEqual({ ok: true, wsUrl: 'wss://home.test/api/ws?profile=work' })
    expect(mintedFor('wss://home.test/api/ws?profile=work')).toEqual({ connectionId: 'home' })

    expect(await bridge.getGatewayWsUrlFor({ connectionId: 'cloud', profile: 'work' })).toEqual({
      ok: true,
      wsUrl: 'wss://cloud.test/api/ws?ticket=TICKET&profile=work'
    })
    expect(mintedFor('wss://cloud.test/api/ws?ticket=TICKET&profile=work')).toEqual({ connectionId: 'cloud' })
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

describe('a REST call', () => {
  const call = (connectionId?: null | string) => {
    installHermesDesktopBridge()

    return window.hermesDesktop.api({ connectionId, path: '/api/status', profile: 'work' })
  }

  it("takes the active path for the primary's own id, which needs no lease", async () => {
    activate('box')

    expect(await call('box')).toEqual({ ok: true })
    expect(await call(null)).toEqual({ ok: true })
    expect(apiMock.mock.calls.map(([request]) => request.connectionId)).toEqual([undefined, undefined])
    expect(apiMock).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/status', profile: 'work' }))
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it('names another connection that has a URL of its own', async () => {
    activate('box')

    await call('home')

    expect(apiMock).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'home' }))
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it('holds the tunnel of another local or SSH connection for the length of the call', async () => {
    activate('home')
    apiMock.mockImplementationOnce(async () => {
      expect(leases[0].release).not.toHaveBeenCalled()

      return { ok: true }
    })

    await call('box')

    expect(acquireMock).toHaveBeenCalledWith('box', { label: 'Box' })
    expect(apiMock).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'box' }))
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('lets go of the tunnel when the call fails', async () => {
    activate('home')
    apiMock.mockRejectedValueOnce(new Error('GET /api/status → HTTP 500: '))

    await expect(call('box')).rejects.toThrow('HTTP 500')
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('reports a tunnel failure as copy, and sends nothing', async () => {
    activate('home')
    acquireMock.mockRejectedValueOnce({ kind: 'unreachable', message: 'ssh: connect to me@box', terminal: true })

    const failure = await call('box').catch((error: Error) => error.message)

    expect(failure).not.toContain('me@box')
    expect(apiMock).not.toHaveBeenCalled()
  })
})

describe('the boot cookie restore', () => {
  it('is waited on by a dial and by a REST call, so neither meets an empty jar', async () => {
    let finish = (): void => {}

    cookies.restored = new Promise<void>(resolve => (finish = resolve))
    activate('home')

    installHermesDesktopBridge()

    const dial = bridge.getConnection()
    const rest = window.hermesDesktop.api({ path: '/api/status' })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(invokeMock).not.toHaveBeenCalled()
    expect(apiMock).not.toHaveBeenCalled()

    finish()

    await expect(dial).resolves.toMatchObject({ connectionId: 'home' })
    await expect(rest).resolves.toEqual({ ok: true })
  })
})

describe('signals with no universal source', () => {
  it('subscribe and never fire', () => {
    const callback = vi.fn()

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

    for (const member of [
      'getBootProgress',
      'getConnection',
      'getConnectionFor',
      'getGatewayWsUrl',
      'getGatewayWsUrlFor',
      'onBootProgress',
      'onConnectionApplied',
      'profile'
    ]) {
      expect(installed[member]).toBe((bridge as Record<string, unknown>)[member])
    }

    // Feature-detected by the boot hook and the registry; a fake would be believed.
    for (const member of ['connections', 'revalidateConnection', 'setActiveConnectionRoute']) {
      expect(installed[member]).toBeUndefined()
    }
  })
})
