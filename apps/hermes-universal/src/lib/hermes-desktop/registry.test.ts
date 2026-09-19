import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionView, RegistryView } from '@/store/connections'

// `hermesDesktop.connections` over universal's registry store: what each member
// delegates to, what it answers in desktop's shape, and what never crosses —
// a token, a loopback address, Rust's text for a failure that names a host.

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

const BOX: ConnectionView = {
  ...base,
  hasToken: false,
  host: 'box.internal',
  id: 'box',
  keyPath: '~/.ssh/id',
  kind: 'ssh',
  label: 'Box',
  order: 2,
  port: 2222,
  remoteProfile: 'work',
  user: 'deploy'
}

const LEGACY_BOX: ConnectionView = { ...BOX, id: 'old-box', label: 'Old box', legacy: true }

const view = (connections: ConnectionView[] = [LOCAL, HOME, BOX, LEGACY_BOX]): RegistryView => ({
  connections,
  keyringAvailable: true,
  lastUsed: 'home',
  launchMode: 'last-used',
  localSupported: true,
  primary: 'local',
  readOnly: false,
  version: 2
})

const store = vi.hoisted(() => ({
  connectionById: vi.fn(),
  refreshConnections: vi.fn(),
  removeConnection: vi.fn(),
  saveConnection: vi.fn(),
  setLastUsedConnection: vi.fn(),
  setLaunchMode: vi.fn(),
  setPrimaryConnection: vi.fn(),
  testConnection: vi.fn()
}))

const ssh = vi.hoisted(() => ({
  attachSshPrompts: vi.fn(async (_attemptId: string) => vi.fn()),
  newAttemptId: () => 'attempt-1',
  testSshBackend: vi.fn()
}))

const secrets = vi.hoisted(() => ({ loadSshSecrets: vi.fn() }))
const local = vi.hoisted(() => ({ localBackendStatus: vi.fn() }))
const updates = vi.hoisted(() => ({ updateSources: vi.fn() }))

const bus = vi.hoisted(() => ({
  handler: null as ((event: { payload: unknown }) => void) | null,
  unlisten: vi.fn()
}))

vi.mock('@/store/connections', () => store)
vi.mock('@/store/ssh-backend', () => ssh)
vi.mock('@/lib/secure-store', () => secrets)
vi.mock('@/store/local-backend', () => local)
vi.mock('@/store/connection-updates', () => updates)
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    bus.handler = handler

    return bus.unlisten
  })
}))

import { changedReason, registryBridge, registryError } from './registry'
import { toDesktopRegistry } from './registry-shape'

const { connections } = registryBridge

beforeEach(() => {
  vi.clearAllMocks()
  bus.handler = null

  const rows = view()

  store.connectionById.mockImplementation((id: string) => rows.connections.find(row => row.id === id))
  store.refreshConnections.mockResolvedValue(rows)
  store.removeConnection.mockResolvedValue(rows)
  store.setLastUsedConnection.mockResolvedValue(rows)
  store.setLaunchMode.mockResolvedValue(rows)
  store.setPrimaryConnection.mockResolvedValue(rows)
  store.saveConnection.mockImplementation(async (input: { id?: string }) => ({
    connectionId: input.id ?? 'home',
    dialFieldsChanged: false,
    droppedHeaders: [],
    registry: rows
  }))
})

describe('connections.list', () => {
  it('reads Rust’s registry through the store, in desktop’s shape', async () => {
    const listed = await connections.list()

    expect(store.refreshConnections).toHaveBeenCalledOnce()
    expect(listed).toEqual(toDesktopRegistry(view()))
    expect(listed.connections.map(row => row.kind)).toEqual(['local', 'remote', 'ssh', 'ssh'])
  })
})

describe('connections.save', () => {
  it('merges onto the row being edited and answers the saved row, never the token', async () => {
    const result = await connections.save({
      authMode: 'token',
      id: 'home',
      kind: 'remote',
      label: 'Homelab',
      token: 's3cret-token',
      url: 'https://home.test'
    })

    expect(store.saveConnection).toHaveBeenCalledExactlyOnceWith({
      authMode: 'token',
      id: 'home',
      kind: 'remote',
      label: 'Homelab',
      token: 's3cret-token',
      url: 'https://home.test'
    })
    expect(result.ok).toBe(true)
    expect(result.connection).toMatchObject({ id: 'home', tokenPreview: 'c0de', tokenSet: true })
    expect(JSON.stringify(result)).not.toContain('s3cret-token')
  })

  it('saves an SSH row from desktop’s form without naming a field that form does not show', async () => {
    await connections.save({ host: 'deploy@box.internal:2222', id: 'box', kind: 'ssh', label: 'Box' })

    expect(store.saveConnection).toHaveBeenCalledExactlyOnceWith({
      host: 'deploy@box.internal:2222',
      id: 'box',
      kind: 'ssh',
      label: 'Box'
    })
  })

  it('reports the registry’s own refusal in its words', async () => {
    store.saveConnection.mockRejectedValueOnce({
      kind: 'duplicate-label',
      message: 'another gateway is already called "Homelab"'
    })

    await expect(connections.save({ kind: 'remote', label: 'Homelab', url: 'https://x.test' })).rejects.toThrow(
      'another gateway is already called "Homelab"'
    )
  })

  it('never quotes an address back, nor an OS error', async () => {
    store.saveConnection.mockRejectedValueOnce({ kind: 'invalid-input', message: 'ht!tp://bad is not a valid URL' })

    const refused = await connections.save({ kind: 'remote', label: 'X', url: 'ht!tp://bad' }).catch(error => error)

    expect(refused).toBeInstanceOf(Error)
    expect(refused.message).toBe('Could not save the connection')

    store.saveConnection.mockRejectedValueOnce({ kind: 'write-failed', message: 'EACCES /home/me/.local/share/x.json' })

    await expect(connections.save({ kind: 'remote', label: 'X', url: 'https://x.test' })).rejects.toThrow(
      'Could not save the connection'
    )
  })
})

describe('the registry’s pointers', () => {
  it('removes, sets the primary, the launch mode and the last-used source through the store', async () => {
    expect(await connections.remove('home')).toEqual({ ok: true, registry: toDesktopRegistry(view()) })
    expect(store.removeConnection).toHaveBeenCalledExactlyOnceWith('home')

    expect((await connections.setPrimary('box')).ok).toBe(true)
    expect(store.setPrimaryConnection).toHaveBeenCalledExactlyOnceWith('box')

    expect((await connections.setLaunchMode('primary')).ok).toBe(true)
    expect(store.setLaunchMode).toHaveBeenCalledExactlyOnceWith('primary')

    expect((await connections.setLastUsed('box')).ok).toBe(true)
    expect(store.setLastUsedConnection).toHaveBeenCalledExactlyOnceWith('box')
  })

  it('refuses a launch mode Rust does not have, before asking it', async () => {
    await expect(connections.setLaunchMode('whenever' as 'primary')).rejects.toThrow()
    expect(store.setLaunchMode).not.toHaveBeenCalled()
  })

  it('says why this device’s own backend cannot be removed', async () => {
    store.removeConnection.mockRejectedValueOnce({
      kind: 'local-not-removable',
      message: "this device's own backend can't be removed"
    })

    await expect(connections.remove('local')).rejects.toThrow("this device's own backend can't be removed")
  })
})

describe('connections.test', () => {
  it('runs Rust’s two-leg probe on a URL row, and publishes nothing', async () => {
    store.testConnection.mockResolvedValueOnce({ ok: true, verdict: 'ok', version: '0.9.1' })

    expect(await connections.test('home')).toEqual({
      baseUrl: 'https://home.test',
      ok: true,
      reachable: true,
      version: '0.9.1'
    })
    expect(store.testConnection).toHaveBeenCalledExactlyOnceWith('home')
    expect(store.saveConnection).not.toHaveBeenCalled()
  })

  it('words a failed probe by its verdict', async () => {
    store.testConnection.mockResolvedValueOnce({ ok: false, verdict: 'credential-rejected' })

    expect(await connections.test('home')).toEqual({
      baseUrl: 'https://home.test',
      error: 'The gateway accepted the connection then closed it (credential rejected?)',
      ok: false,
      reachable: false
    })
  })

  it('tests a registered SSH row by id: Rust reads its credentials, and a person may be asked', async () => {
    ssh.testSshBackend.mockResolvedValueOnce({ hostLabel: 'deploy@box', platform: 'linux', reachable: true })

    expect(await connections.test('box')).toEqual({
      host: 'deploy@box',
      ok: true,
      reachable: true,
      remotePlatform: 'linux'
    })
    expect(ssh.attachSshPrompts).toHaveBeenCalledExactlyOnceWith('attempt-1')
    expect(ssh.testSshBackend).toHaveBeenCalledExactlyOnceWith('attempt-1', {
      connectionId: 'box',
      host: 'box.internal',
      interactive: true,
      keyPath: '~/.ssh/id',
      port: 2222,
      remoteHermesPath: undefined,
      user: 'deploy'
    })
    // No secret was read into this page for a registered row.
    expect(secrets.loadSshSecrets).not.toHaveBeenCalled()
  })

  it('tests the pre-registry owner as its dial does: no id, its own bare credentials', async () => {
    secrets.loadSshSecrets.mockResolvedValueOnce({ passphrase: 'open sesame' })
    ssh.testSshBackend.mockResolvedValueOnce({ hostLabel: 'deploy@box', reachable: true })

    await connections.test('old-box')

    const [, config] = ssh.testSshBackend.mock.calls[0]!

    expect(config).toMatchObject({ interactive: true, passphrase: 'open sesame' })
    expect('connectionId' in config).toBe(false)
  })

  it('answers an SSH failure as desktop’s kind and copy, never Rust’s message', async () => {
    ssh.testSshBackend.mockRejectedValueOnce({ kind: 'auth-failed', message: 'deploy@box.internal: permission denied' })

    expect(await connections.test('box')).toEqual({
      error: expect.not.stringContaining('box.internal'),
      ok: false,
      reachable: false,
      sshError: 'auth-failed'
    })

    ssh.testSshBackend.mockRejectedValueOnce({ kind: 'superseded', message: 'x' })

    expect((await connections.test('box')).sshError).toBe('unknown')
  })

  it('starts nothing to test this device’s backend', async () => {
    local.localBackendStatus.mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9119', running: true })

    const up = await connections.test('local')

    expect(up).toEqual({ ok: true, reachable: true })
    expect(JSON.stringify(up)).not.toContain('127.0.0.1')

    local.localBackendStatus.mockResolvedValueOnce({ running: false })

    expect(await connections.test('local')).toEqual({
      error: 'The backend on this device is not running.',
      ok: false,
      reachable: false
    })
  })

  it('rejects an unknown id in the words desktop’s gateway store matches on', async () => {
    await expect(connections.test('ghost')).rejects.toThrow('No connection with id "ghost"')
  })
})

describe('connections.updateAll', () => {
  it('is Rust’s fan-out alone, with each row’s kind, and no address in a failure', async () => {
    updates.updateSources.mockResolvedValueOnce([
      { connectionId: 'home', detail: 'Update started', label: 'Homelab', ok: true, skipped: false },
      {
        connectionId: 'box',
        label: 'Box',
        ok: false,
        reason: 'connect-on-demand',
        skipped: true
      },
      {
        connectionId: 'home',
        detail: 'error sending request for url (https://home.test/api/hermes/update)',
        label: 'Homelab',
        ok: false,
        reason: 'unreachable',
        skipped: false
      }
    ])

    const { ok, results } = await connections.updateAll!({ excludeIds: ['local'] })

    expect(updates.updateSources).toHaveBeenCalledExactlyOnceWith(['local'])
    expect(ok).toBe(true)
    expect(results).toEqual([
      { connectionId: 'home', detail: 'Update started', kind: 'remote', label: 'Homelab', ok: true, skipped: false },
      {
        connectionId: 'box',
        detail: 'Connect to this gateway to update it.',
        kind: 'ssh',
        label: 'Box',
        ok: false,
        reason: 'connect-on-demand',
        skipped: true
      },
      {
        connectionId: 'home',
        error: 'Could not reach this gateway.',
        kind: 'remote',
        label: 'Homelab',
        ok: false,
        reason: 'unreachable',
        skipped: false
      }
    ])
    expect(JSON.stringify(results)).not.toContain('home.test')
  })
})

describe('connections.onChanged', () => {
  it.each([
    [{ connectionId: 'home', reason: 'removed' }, 'removed'],
    [{ connectionId: 'home', dialFieldsChanged: true, reason: 'saved' }, 'updated'],
    [{ connectionId: 'home', dialFieldsChanged: false, reason: 'saved' }, 'saved'],
    // An older Rust core: no flag, so nothing is disposed.
    [{ connectionId: 'home', reason: 'saved' }, 'saved'],
    [{ connectionId: 'home', reason: 'primary' }, 'saved'],
    [{ connectionId: null, reason: 'launch-mode' }, 'saved'],
    // Universal's own cross-window commit: the store applies it.
    [{ connectionId: 'home', dialSeq: 3, reason: 'source', seq: 4 }, null],
    [{}, null]
  ] as const)('%j → %s', (payload, expected) => {
    expect(changedReason(payload)).toBe(expected)
  })

  it('feeds desktop’s listener from Rust’s event, and stops when told', async () => {
    const seen: unknown[] = []
    const off = connections.onChanged!(payload => void seen.push(payload))

    await vi.waitFor(() => expect(bus.handler).not.toBeNull())

    bus.handler!({ payload: { connectionId: 'home', dialFieldsChanged: true, reason: 'saved' } })
    bus.handler!({ payload: { connectionId: 'home', reason: 'source', seq: 2 } })
    bus.handler!({ payload: { connectionId: null, reason: 'launch-mode' } })

    expect(seen).toEqual([
      { connectionId: 'home', reason: 'updated' },
      { connectionId: '', reason: 'saved' }
    ])

    off()

    expect(bus.unlisten).toHaveBeenCalledOnce()
  })

  it('unsubscribes a listener that was stopped before the bus answered', async () => {
    connections.onChanged!(() => {})()

    await vi.waitFor(() => expect(bus.unlisten).toHaveBeenCalledOnce())
  })
})

describe('registryError', () => {
  it('passes this app’s own errors through, and replaces anything it cannot vouch for', () => {
    const own = new Error('mine')

    expect(registryError(own, 'copy')).toBe(own)
    expect(registryError('tcp connect error: 10.0.0.4:443', 'copy').message).toBe('copy')
    expect(registryError({ kind: 'mystery', message: 'm' }, 'copy').message).toBe('copy')
    expect(
      registryError({ kind: 'registry-full', message: 'this device can hold at most 32 gateways' }, 'copy').message
    ).toBe('this device can hold at most 32 gateways')
  })
})

describe('the namespace', () => {
  it('is complete for every member desktop calls, bar the managed SSH update', () => {
    expect(Object.keys(connections).sort()).toEqual([
      'list',
      'onChanged',
      'remove',
      'save',
      'setLastUsed',
      'setLaunchMode',
      'setPrimary',
      'test',
      'updateAll'
    ])
  })
})
