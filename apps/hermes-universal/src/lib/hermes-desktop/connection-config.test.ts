import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionTarget, ConnectionView, RegistryView } from '@/store/connections'

// Electron's v1 connection config over registry rows: which row a read
// describes, what a save and an apply write and in what order, and that a test
// or a probe publishes and dials nothing.

const base = { hasSshKey: false, hasSshPassphrase: false, hasSshPassword: false, headerNames: [], legacy: false }

const LOCAL: ConnectionView = { ...base, hasToken: false, id: 'local', kind: 'local', label: 'This device', order: 0 }

const HOME: ConnectionView = {
  ...base,
  authMode: 'token',
  hasToken: true,
  id: 'home',
  kind: 'remote',
  label: 'Homelab',
  order: 1,
  tokenPreview: 'c0de',
  url: 'https://home.test'
}

const GATED: ConnectionView = { ...HOME, authMode: 'oauth', hasToken: false, id: 'gated', url: 'https://gated.test' }
const OPEN: ConnectionView = { ...HOME, authMode: 'none', hasToken: false, id: 'open', url: 'https://open.test' }

const BOX: ConnectionView = {
  ...base,
  hasToken: false,
  host: 'box.internal',
  id: 'box',
  kind: 'ssh',
  label: 'Box',
  order: 2,
  user: 'deploy'
}

const rows = vi.hoisted(() => ({ view: null as null | RegistryView }))
const active = vi.hoisted(() => ({ id: null as null | string }))
const order = vi.hoisted(() => [] as string[])

const store = vi.hoisted(() => ({
  applyConnection: vi.fn(),
  connectionRowFor: vi.fn(),
  refreshConnections: vi.fn(),
  saveConnectionTarget: vi.fn(),
  setLastUsedConnection: vi.fn(),
  setPrimaryConnection: vi.fn(),
  testConnection: vi.fn()
}))

const connection = vi.hoisted(() => ({
  authenticate: vi.fn(),
  normalizeBaseUrl: (raw: string) =>
    (/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`).replace(/\/+$/, ''),
  probeStatus: vi.fn()
}))

const auth = vi.hoisted(() => ({
  fetchAuthProviders: vi.fn(),
  mintWsTicket: vi.fn(),
  oauthLogout: vi.fn(),
  oauthStatus: vi.fn()
}))

const http = vi.hoisted(() => ({ httpRequest: vi.fn() }))

const ssh = vi.hoisted(() => ({
  attachSshPrompts: vi.fn(async () => vi.fn()),
  newAttemptId: () => 'a1',
  testSshBackend: vi.fn()
}))

const local = vi.hoisted(() => ({ localBackendStatus: vi.fn() }))

vi.mock('@/store/connections', () => store)
vi.mock('@/store/connection', () => connection)
vi.mock('@/lib/auth', () => auth)
vi.mock('@/transport/http', () => http)
vi.mock('@/store/ssh-backend', () => ssh)
vi.mock('@/store/local-backend', () => local)
vi.mock('@/lib/secure-store', () => ({ loadSshSecrets: vi.fn(async () => ({})) }))
vi.mock('@/store/active-connection', () => ({
  $activeConnection: { get: () => (active.id ? { connectionId: active.id } : null) },
  launchSettled: async () => {}
}))

import { __testing, connectionConfigBridge as bridge } from './connection-config'

const view = (connections: ConnectionView[], primary = 'local'): RegistryView => ({
  connections,
  keyringAvailable: true,
  lastUsed: primary,
  launchMode: 'last-used',
  localSupported: true,
  primary,
  readOnly: false,
  version: 2
})

beforeEach(() => {
  vi.clearAllMocks()
  __testing.reset()
  order.length = 0
  active.id = null
  rows.view = view([LOCAL, HOME, GATED, OPEN, BOX])

  store.refreshConnections.mockImplementation(async () => rows.view)
  store.connectionRowFor.mockImplementation((target: ConnectionTarget, registry: RegistryView) =>
    registry.connections.find(row =>
      target.kind === 'local'
        ? row.kind === 'local'
        : target.kind === 'ssh'
          ? row.kind === 'ssh' && row.host === target.host
          : row.url === target.url
    )
  )
  store.saveConnectionTarget.mockImplementation(async () => (order.push('save'), 'home'))
  store.applyConnection.mockImplementation(async () => (order.push('apply'), 'home'))
  store.setPrimaryConnection.mockImplementation(async () => void order.push('primary'))
  store.setLastUsedConnection.mockImplementation(async () => void order.push('last-used'))
  auth.oauthStatus.mockResolvedValue({ signedIn: false })
  auth.oauthLogout.mockResolvedValue(undefined)
  connection.probeStatus.mockResolvedValue({ auth_required: false, version: '0.9.1' })
})

describe('getConnectionConfig', () => {
  it('describes the row this window is on', async () => {
    active.id = 'home'

    expect(await bridge.getConnectionConfig(null)).toMatchObject({
      mode: 'remote',
      profile: null,
      remoteTokenPreview: 'c0de',
      remoteTokenSet: true,
      remoteUrl: 'https://home.test'
    })
  })

  it('falls back to the registry’s primary before the window is on anything', async () => {
    rows.view = view([LOCAL, HOME, BOX], 'box')

    expect(await bridge.getConnectionConfig()).toMatchObject({
      mode: 'ssh',
      sshHost: 'box.internal',
      sshUser: 'deploy'
    })
  })

  it('reads a gated row’s session from Rust, and "could not tell" is not connected', async () => {
    active.id = 'gated'
    auth.oauthStatus.mockResolvedValueOnce({ signedIn: true })

    expect((await bridge.getConnectionConfig(null)).remoteOauthConnected).toBe(true)
    expect(auth.oauthStatus).toHaveBeenCalledWith('https://gated.test')

    auth.oauthStatus.mockRejectedValueOnce('dns error')

    expect((await bridge.getConnectionConfig(null)).remoteOauthConnected).toBe(false)
  })

  it('never asks for a session on a token row', async () => {
    active.id = 'home'
    await bridge.getConnectionConfig(null)

    expect(auth.oauthStatus).not.toHaveBeenCalled()
  })

  it('reads a NAMED profile as local: no profile has a gateway of its own', async () => {
    active.id = 'home'

    expect(await bridge.getConnectionConfig('work')).toMatchObject({ mode: 'local', profile: 'work', remoteUrl: '' })
    expect(store.refreshConnections).not.toHaveBeenCalled()
  })
})

describe('saveConnectionConfig', () => {
  const payload = {
    mode: 'remote',
    remoteAuthMode: 'token',
    remoteToken: 'n3w',
    remoteUrl: 'https://home.test'
  } as const

  it('writes the row, makes it where the next launch lands, and switches nothing', async () => {
    active.id = 'local'

    const saved = await bridge.saveConnectionConfig(payload)

    expect(store.saveConnectionTarget).toHaveBeenCalledExactlyOnceWith({
      authMode: 'token',
      kind: 'remote',
      token: 'n3w',
      url: 'https://home.test'
    })
    expect(order).toEqual(['save', 'primary', 'last-used'])
    expect(store.applyConnection).not.toHaveBeenCalled()
    // Desktop's sign-in saves, signs in, then re-reads WHAT IT SAVED — not the
    // row the window is still on.
    expect(saved).toMatchObject({ mode: 'remote', remoteUrl: 'https://home.test' })
    expect(JSON.stringify(saved)).not.toContain('n3w')
  })

  it('does not re-stamp a row that asks for nothing with the form’s default', async () => {
    await bridge.saveConnectionConfig({ mode: 'remote', remoteAuthMode: 'token', remoteUrl: 'https://open.test' })

    expect(store.saveConnectionTarget).toHaveBeenCalledExactlyOnceWith({ kind: 'remote', url: 'https://open.test' })
  })

  it('refuses a gateway of a profile’s own, and treats "local" for a profile as already true', async () => {
    await expect(bridge.saveConnectionConfig({ ...payload, profile: 'work' })).rejects.toThrow(
      'Named profiles cannot host a non-local gateway configuration.'
    )
    expect(await bridge.saveConnectionConfig({ mode: 'local', profile: 'work' })).toMatchObject({
      mode: 'local',
      profile: 'work'
    })
    expect(store.saveConnectionTarget).not.toHaveBeenCalled()
  })

  it('reports a refused save without the address that was typed', async () => {
    store.saveConnectionTarget.mockRejectedValueOnce({
      kind: 'invalid-input',
      message: 'https://home.test has no host'
    })

    await expect(bridge.saveConnectionConfig(payload)).rejects.toThrow('Could not save gateway settings')
  })
})

describe('applyConnectionConfig', () => {
  it('saves and switches as a person’s click, once, then makes it the launch target', async () => {
    await bridge.applyConnectionConfig({ mode: 'ssh', sshHost: 'box.internal', sshPort: null, sshUser: 'deploy' })

    expect(store.applyConnection).toHaveBeenCalledExactlyOnceWith(
      { host: 'box.internal', kind: 'ssh', user: 'deploy' },
      { allowInteractive: true }
    )
    expect(order).toEqual(['apply', 'primary', 'last-used'])
  })

  it('leaves the launch target alone when the switch fails', async () => {
    store.applyConnection.mockRejectedValueOnce(new Error('Could not switch gateway'))

    await expect(bridge.applyConnectionConfig({ mode: 'local' })).rejects.toThrow('Could not switch gateway')
    expect(order).toEqual([])
  })

  it('keeps a landed switch landed when the list cannot be written', async () => {
    store.setPrimaryConnection.mockRejectedValueOnce({ kind: 'write-failed', message: 'ENOSPC' })
    active.id = 'home'

    await expect(bridge.applyConnectionConfig({ mode: 'local' })).resolves.toMatchObject({ mode: 'remote' })
  })

  it('reads the window’s row again once an apply has landed', async () => {
    active.id = 'local'
    await bridge.saveConnectionConfig({
      mode: 'remote',
      remoteAuthMode: 'token',
      remoteToken: 't',
      remoteUrl: HOME.url
    })

    expect((await bridge.getConnectionConfig(null)).mode).toBe('remote')

    await bridge.applyConnectionConfig({ mode: 'local' })

    expect((await bridge.getConnectionConfig(null)).mode).toBe('local')
  })

  it('removing a profile’s override is a no-op that answers local', async () => {
    expect(await bridge.applyConnectionConfig({ mode: 'local', profile: 'work' })).toMatchObject({ profile: 'work' })
    expect(store.applyConnection).not.toHaveBeenCalled()
  })
})

describe('testConnectionConfig', () => {
  const nothingWritten = () => {
    expect(store.saveConnectionTarget).not.toHaveBeenCalled()
    expect(store.applyConnection).not.toHaveBeenCalled()
    expect(store.setPrimaryConnection).not.toHaveBeenCalled()
  }

  it('runs Rust’s two-leg probe for a saved row whose token was not retyped', async () => {
    store.testConnection.mockResolvedValueOnce({ ok: true, verdict: 'ok', version: '0.9.1' })

    expect(await bridge.testConnectionConfig({ mode: 'remote', remoteAuthMode: 'token', remoteUrl: HOME.url })).toEqual(
      {
        baseUrl: 'https://home.test',
        ok: true,
        reachable: true,
        version: '0.9.1'
      }
    )
    expect(store.testConnection).toHaveBeenCalledExactlyOnceWith('home')
    nothingWritten()
  })

  it('rejects, as Electron’s remote test does, in the verdict’s words', async () => {
    store.testConnection.mockResolvedValueOnce({ ok: false, verdict: 'ws-unreachable' })

    await expect(
      bridge.testConnectionConfig({ mode: 'remote', remoteAuthMode: 'token', remoteUrl: HOME.url })
    ).rejects.toThrow('The gateway answered, but its socket refused the connection.')
  })

  it('proves a typed token against an unsaved gateway without saving it', async () => {
    http.httpRequest.mockResolvedValueOnce({ body: '{}', status: 200 })

    const result = await bridge.testConnectionConfig({
      mode: 'remote',
      remoteAuthMode: 'token',
      remoteToken: 'typed',
      remoteUrl: 'https://new.test/'
    })

    expect(result).toEqual({ baseUrl: 'https://new.test', ok: true, reachable: true, version: '0.9.1' })
    expect(http.httpRequest).toHaveBeenCalledExactlyOnceWith('GET', 'https://new.test/api/profiles', {
      headers: { 'X-Hermes-Session-Token': 'typed' },
      timeoutMs: 8_000
    })
    nothingWritten()
  })

  it('says a typed token was rejected', async () => {
    http.httpRequest.mockResolvedValueOnce({ body: '', status: 401 })

    await expect(
      bridge.testConnectionConfig({
        mode: 'remote',
        remoteAuthMode: 'token',
        remoteToken: 'bad',
        remoteUrl: 'https://new.test'
      })
    ).rejects.toThrow('credential rejected')
  })

  it('proves a session by minting a socket ticket, and says sign in when there is none', async () => {
    connection.probeStatus.mockResolvedValue({ auth_required: true })
    auth.mintWsTicket.mockResolvedValueOnce('TICKET')

    const gated = { mode: 'remote', remoteAuthMode: 'oauth', remoteUrl: 'https://fresh.test' } as const

    expect((await bridge.testConnectionConfig(gated)).ok).toBe(true)

    auth.mintWsTicket.mockRejectedValueOnce('401 https://fresh.test/api/ws-ticket')

    const refused = await bridge.testConnectionConfig(gated).catch(error => error)

    expect(refused.message).toBe('Sign in to this gateway to continue.')
    nothingWritten()
  })

  it('never quotes the address of a gateway it could not reach', async () => {
    connection.probeStatus.mockRejectedValueOnce('error sending request for url (https://down.test/api/status)')

    const refused = await bridge
      .testConnectionConfig({
        mode: 'remote',
        remoteAuthMode: 'token',
        remoteToken: 't',
        remoteUrl: 'https://down.test'
      })
      .catch(error => error)

    expect(refused.message).toBe('Could not reach this gateway.')
  })

  it('tests an SSH target through Rust’s throwaway session, by row when one points there', async () => {
    ssh.testSshBackend.mockResolvedValueOnce({ hostLabel: 'deploy@box', platform: 'linux', reachable: true })

    expect(
      await bridge.testConnectionConfig({ mode: 'ssh', sshHost: 'box.internal', sshPort: null, sshUser: 'deploy' })
    ).toEqual({ host: 'deploy@box', ok: true, reachable: true, remotePlatform: 'linux' })
    expect(ssh.testSshBackend).toHaveBeenCalledExactlyOnceWith(
      'a1',
      expect.objectContaining({ connectionId: 'box', host: 'box.internal', interactive: true, user: 'deploy' })
    )
    nothingWritten()
  })

  it('answers an SSH failure rather than rejecting, as desktop’s form expects', async () => {
    ssh.testSshBackend.mockRejectedValueOnce({ kind: 'host-key-changed', message: 'box.internal key changed' })

    expect(await bridge.testConnectionConfig({ mode: 'ssh', sshHost: 'nowhere' })).toMatchObject({
      reachable: false,
      sshError: 'host-key-changed'
    })
  })
})

describe('probeConnectionConfig', () => {
  it('reports how a gateway authenticates, with its providers, sending no credential', async () => {
    connection.probeStatus.mockResolvedValueOnce({ auth_required: true, version: '0.9.1' })
    auth.fetchAuthProviders.mockResolvedValueOnce([
      { display_name: 'Nous Research', name: 'nous', supports_password: false },
      { display_name: '', name: 'ldap', supports_password: true }
    ])

    expect(await bridge.probeConnectionConfig('gated.test/')).toEqual({
      authMode: 'oauth',
      baseUrl: 'http://gated.test',
      error: null,
      providers: [
        { displayName: 'Nous Research', name: 'nous', supportsPassword: false },
        { displayName: 'ldap', name: 'ldap', supportsPassword: true }
      ],
      reachable: true,
      version: '0.9.1'
    })
  })

  it('reads an open gateway as the token form, and asks for no providers', async () => {
    expect(await bridge.probeConnectionConfig('https://open.test')).toMatchObject({ authMode: 'token', providers: [] })
    expect(auth.fetchAuthProviders).not.toHaveBeenCalled()
  })

  it('never rejects: a half-typed URL is "can’t tell yet", in this app’s words', async () => {
    connection.probeStatus.mockRejectedValueOnce('dns error: failed to lookup half.typ')

    expect(await bridge.probeConnectionConfig('https://half.typ')).toEqual({
      authMode: 'unknown',
      baseUrl: 'https://half.typ',
      error: 'Could not reach this gateway.',
      providers: [],
      reachable: false,
      version: null
    })
  })
})

describe('the sign-in doors', () => {
  it('signs in through the store’s interactive preflight, naming the row for a phone’s resume', async () => {
    auth.oauthStatus.mockResolvedValueOnce({ signedIn: true })

    expect(await bridge.oauthLoginConnectionConfig('https://gated.test/')).toEqual({
      baseUrl: 'https://gated.test',
      connected: true,
      ok: true
    })
    expect(connection.authenticate).toHaveBeenCalledExactlyOnceWith({
      allowInteractive: true,
      connectionId: 'gated',
      url: 'https://gated.test'
    })
  })

  it('answers an unfinished sign-in as not connected, and a failed one in this app’s words', async () => {
    expect((await bridge.oauthLoginConnectionConfig('https://gated.test')).connected).toBe(false)

    connection.authenticate.mockRejectedValueOnce('listener bind failed 127.0.0.1:53111')

    await expect(bridge.oauthLoginConnectionConfig('https://gated.test')).rejects.toThrow('Sign-in failed')
  })

  it('signs out of that gateway only, and reports what is still live', async () => {
    expect(await bridge.oauthLogoutConnectionConfig('https://gated.test')).toEqual({ connected: false, ok: true })
    expect(auth.oauthLogout).toHaveBeenCalledExactlyOnceWith('https://gated.test')
  })
})

describe('secret storage', () => {
  it('reports where secrets already are: the OS credential store, when there is one', async () => {
    expect(await bridge.getSecretStorageEncryption!()).toEqual({ on: true })
    expect(await bridge.setSecretStorageEncryption(true)).toEqual({ on: true })
  })

  it('refuses the one change it could make, either way', async () => {
    await expect(bridge.setSecretStorageEncryption(false)).rejects.toThrow(
      'Secrets are stored on disk for this platform.'
    )

    rows.view = { ...view([LOCAL]), keyringAvailable: false }

    expect(await bridge.getSecretStorageEncryption!()).toEqual({ on: false })
    await expect(bridge.setSecretStorageEncryption(true)).rejects.toThrow(
      'No OS keyring is available — secrets will be stored on disk.'
    )
  })
})
