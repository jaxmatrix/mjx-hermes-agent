import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two-phase switch (MJXHRM-602): preflight with the current source untouched,
// then publish → persist → dispose → broadcast → emit → release. `order` records
// the commit as it happens, across every seam it crosses.
const {
  acquireTunnel,
  authenticate,
  broadcastGatewaySwitch,
  desktop,
  disposeSecondariesForConnection,
  emitConnectionApplied,
  invoke,
  keepSession,
  mergeSshSecrets,
  notify,
  oauthStatus,
  order,
  platform,
  portalAgentSignIn,
  takePendingOAuth
} = vi.hoisted(() => {
  const order: string[] = []

  return {
    acquireTunnel: vi.fn(),
    authenticate: vi.fn(),
    broadcastGatewaySwitch: vi.fn(() => void order.push('broadcast')),
    desktop: {} as { connection?: { set(value: unknown): void }; profile?: { set(value: string): void } },
    disposeSecondariesForConnection: vi.fn(() => void order.push('dispose')),
    emitConnectionApplied: vi.fn(() => void order.push('emit')),
    invoke: vi.fn(),
    keepSession: vi.fn(async () => {}),
    mergeSshSecrets: vi.fn(async () => true),
    notify: vi.fn(),
    oauthStatus: vi.fn(),
    order,
    platform: { tauri: true },
    portalAgentSignIn: vi.fn(),
    takePendingOAuth: vi.fn()
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }))
vi.mock('@/hermes', () => ({ setApiRequestProfile: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  oauthStatus,
  oauthStatusIsUnknown: (status: { reachable?: boolean }) => status.reachable === false,
  portalAgentSignIn
}))
vi.mock('@/lib/hermes-desktop/connection-applied', () => ({ emitConnectionApplied }))
vi.mock('@/lib/platform', () => ({
  get IS_TAURI() {
    return platform.tauri
  }
}))
vi.mock('@/lib/secure-store', () => ({ mergeSshSecrets }))
vi.mock('@/store/connection', () => ({ authenticate, keepSession }))
vi.mock('@/store/connection-tunnels', () => ({
  acquireTunnel,
  connectionBase: vi.fn(),
  liveTunnelBase: vi.fn(() => null),
  setTunnelAnswerSaver: vi.fn()
}))
// Desktop's registry and the two atoms its last-profile writer reads.
vi.mock('@/store/gateway', () => ({ disposeSecondariesForConnection }))
vi.mock('@/store/gateway-restore', async () => {
  const { atom } = await import('@/store/atom')

  return { $restoring: atom(true), loadGatewayTarget: () => null, takePendingOAuth }
})
vi.mock('@/store/gateway-switch-broadcast', () => ({ broadcastGatewaySwitch }))
vi.mock('@/store/notifications', () => ({ notify, notifyError: vi.fn() }))
vi.mock('@/store/profile', async () => {
  const { atom } = await import('@/store/atom')

  desktop.profile = atom('default')

  return {
    $activeGatewayProfile: desktop.profile,
    normalizeProfileKey: (name?: null | string) => (name ?? '').trim() || 'default'
  }
})
vi.mock('@/store/session', async () => {
  const { atom } = await import('@/store/atom')

  desktop.connection = atom<unknown>(null)

  return { $connection: desktop.connection }
})

import { LOCAL_CONNECTION_ID } from '@/lib/backend-scope'

import { $activeConnection, describeConnection, publishActiveConnection } from './active-connection'
import { $latchedConnections, __resetConnectionLatches } from './connection-latches'
import {
  $activeConnectionId,
  $connectionsRegistry,
  $hasMultipleConnections,
  $pendingConnectionId,
  __testing,
  applyConnection,
  followConnection,
  initializeConnectionsRegistry,
  lastProfileFor,
  loadConnectionsRegistry,
  restoreLaunchConnection,
  saveTunnelAnswer,
  selectConnection
} from './connections'
import { $restoring } from './gateway-restore'

const RESOLVED = {
  connectionId: 'studio',
  dialConnectionId: 'studio',
  headerNames: [],
  kind: 'remote',
  label: 'Studio',
  mode: 'remote',
  baseUrl: 'https://studio.test',
  scopeKey: 'conn:studio::default',
  tokenAttached: false
}

const SSH = { ...RESOLVED, baseUrl: undefined, kind: 'ssh', mode: 'ssh', remoteHost: 'deploy@box' }

function seedRegistry(ids: string[], overrides: Record<string, unknown> = {}): void {
  $connectionsRegistry.set({
    connections: ids.map((id, order) => ({
      hasSshKey: false,
      hasSshPassphrase: false,
      hasSshPassword: false,
      hasToken: false,
      headerNames: [],
      id,
      kind: 'remote' as const,
      label: id,
      legacy: id === LOCAL_CONNECTION_ID,
      order,
      url: `https://${id}.test`
    })),
    keyringAvailable: true,
    lastUsed: ids[0] ?? LOCAL_CONNECTION_ID,
    launchMode: 'last-used',
    localSupported: true,
    primary: ids[0] ?? LOCAL_CONNECTION_ID,
    readOnly: false,
    version: 2,
    ...overrides
  })
}

/** Rust, as far as these tests go: the roster it holds and one resolvable row. */
function rust(resolved: Record<string, unknown> = RESOLVED): void {
  invoke.mockImplementation(async (command: string, args: { connectionId?: string; profile?: null | string } = {}) => {
    if (command === 'connections_resolve') {
      return {
        ...resolved,
        connectionId: args.connectionId,
        dialConnectionId: args.connectionId,
        profile: args.profile ?? undefined
      }
    }

    if (command === 'connections_set_last_used') {
      order.push('persist')
    }

    return command.startsWith('connections_') ? $connectionsRegistry.get() : undefined
  })
}

function lease() {
  return { baseUrl: () => 'http://127.0.0.1:41000', release: vi.fn(() => void order.push('release')) }
}

function onOld(): void {
  publishActiveConnection(
    describeConnection(
      { authMode: 'none', baseUrl: 'https://old.test', mode: 'remote' },
      { connectionId: 'old', dialConnectionId: 'old', label: 'Old' }
    )
  )
}

$activeConnection.listen(active => void (active && order.push(`publish:${active.connectionId}`)))

beforeEach(() => {
  vi.clearAllMocks()
  order.length = 0
  platform.tauri = true
  localStorage.clear()
  __testing.reset()
  __resetConnectionLatches()
  publishActiveConnection(null)
  desktop.connection?.set(null)
  desktop.profile?.set('default')
  $restoring.set(true)
  takePendingOAuth.mockReturnValue(null)
  authenticate.mockImplementation(async ({ url }: { url: string }) => ({
    authMode: 'oauth',
    baseUrl: url,
    mode: 'remote'
  }))
  rust()
})

describe('$hasMultipleConnections', () => {
  it('is the ONE gate for source chrome, and is false for a single-source install', () => {
    seedRegistry([LOCAL_CONNECTION_ID])
    expect($hasMultipleConnections.get()).toBe(false)

    seedRegistry([LOCAL_CONNECTION_ID, 'studio'])
    expect($hasMultipleConnections.get()).toBe(true)
  })
})

describe('loadConnectionsRegistry', () => {
  it('seeds and publishes the roster without dialling, and reports a degraded one once', async () => {
    seedRegistry(['home', 'studio'])

    const registry = { ...$connectionsRegistry.get(), degraded: true }

    __testing.reset()
    invoke.mockImplementation(async () => registry)

    await loadConnectionsRegistry()
    await loadConnectionsRegistry()

    expect(invoke).toHaveBeenCalledWith('connections_migrate', { legacyTarget: null })
    expect($connectionsRegistry.get()).toBe(registry)
    expect(notify).toHaveBeenCalledTimes(1)
    expect($activeConnection.get()).toBeNull()
  })
})

// Boot: W0 → W1 by identity alone. Desktop's fold dials through the bridge.
describe('restoreLaunchConnection', () => {
  it('publishes the launch identity without a preflight, a dial or a broadcast', async () => {
    seedRegistry(['home', 'studio'], { lastUsed: 'studio' })

    await restoreLaunchConnection(true)

    expect(invoke).toHaveBeenCalledWith('connections_migrate', { legacyTarget: null })
    expect($activeConnection.get()).toMatchObject({
      connection: { authMode: 'none', baseUrl: 'https://studio.test', mode: 'remote' },
      connectionId: 'studio'
    })
    expect(authenticate).not.toHaveBeenCalled()
    expect(acquireTunnel).not.toHaveBeenCalled()
    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
    expect(emitConnectionApplied).not.toHaveBeenCalled()
    expect($restoring.get()).toBe(false)
  })

  it("publishes a tunnelled source with no address: its base is the dial's to find", async () => {
    seedRegistry(['box'])
    rust(SSH)

    await restoreLaunchConnection(true)

    expect($activeConnection.get()?.connection).toMatchObject({ authMode: 'token', baseUrl: '', mode: 'ssh' })
    expect($activeConnection.get()?.connection.token).toBeUndefined()
    expect(acquireTunnel).not.toHaveBeenCalled()
  })

  it('honours the launch mode in the window that owns app state, and remembers where it landed', async () => {
    seedRegistry(['home', 'studio'], { lastUsed: 'studio', launchMode: 'primary' })

    await restoreLaunchConnection(true)

    expect($activeConnection.get()?.connectionId).toBe('home')
    expect(invoke).toHaveBeenCalledWith('connections_set_last_used', { connectionId: 'home' })
  })

  it('opens every other window onto the source the app is on, seeding and remembering nothing', async () => {
    seedRegistry(['home', 'studio'], { lastUsed: 'studio', launchMode: 'primary' })

    await restoreLaunchConnection(false)

    expect($activeConnection.get()?.connectionId).toBe('studio')
    expect(invoke).toHaveBeenCalledWith('connections_list', {})
    expect(invoke).not.toHaveBeenCalledWith('connections_migrate', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('connections_set_last_used', expect.anything())
  })

  it('falls back to the primary when the last-used row is gone', async () => {
    seedRegistry(['home'], { lastUsed: 'removed' })

    await restoreLaunchConnection(true)

    expect($activeConnection.get()?.connectionId).toBe('home')
  })

  // A phone cannot run a backend, so a fresh one has no row at all.
  it('stays unconfigured on a phone with nothing configured', async () => {
    seedRegistry([], { localSupported: false })

    await restoreLaunchConnection(true)

    expect($activeConnection.get()).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('connections_resolve', expect.anything())
    expect($restoring.get()).toBe(false)
  })

  it('settles unconfigured when the registry cannot be read', async () => {
    invoke.mockRejectedValue(new Error('no registry'))

    await expect(restoreLaunchConnection(true)).resolves.toBeUndefined()

    expect($activeConnection.get()).toBeNull()
    expect($restoring.get()).toBe(false)
  })

  it('finishes the switch a mobile sign-in navigated away from, on the row it was for', async () => {
    seedRegistry(['home', 'studio'])
    takePendingOAuth.mockReturnValue({ base: 'https://studio.test', connectionId: 'studio' })
    oauthStatus.mockResolvedValue({ signedIn: true })

    await restoreLaunchConnection(true)

    expect($activeConnection.get()?.connectionId).toBe('studio')
    // The interrupted switch, completed: never interactive, remembered and told.
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({ allowInteractive: false }))
    expect(broadcastGatewaySwitch).toHaveBeenCalledTimes(1)
  })

  it('launches normally when that sign-in was abandoned', async () => {
    seedRegistry(['home', 'studio'])
    takePendingOAuth.mockReturnValue({ base: 'https://studio.test', connectionId: 'studio' })
    oauthStatus.mockResolvedValue({ signedIn: false })

    await restoreLaunchConnection(true)

    expect($activeConnection.get()?.connectionId).toBe('home')
    expect(authenticate).not.toHaveBeenCalled()
  })

  it("leaves the switcher's own restore with nothing to re-home", async () => {
    seedRegistry(['home', 'studio'], { lastUsed: 'studio' })
    onOld()

    await initializeConnectionsRegistry()

    expect($activeConnection.get()?.connectionId).toBe('old')
    expect(emitConnectionApplied).not.toHaveBeenCalled()
  })
})

describe('selectConnection', () => {
  beforeEach(() => {
    seedRegistry([LOCAL_CONNECTION_ID, 'studio'])
  })

  it('commits in order: publish → persist → dispose → broadcast → emit', async () => {
    await selectConnection('studio')

    expect(order).toEqual(['publish:studio', 'persist', 'dispose', 'broadcast', 'emit'])
    expect($activeConnection.get()).toMatchObject({ connectionId: 'studio', label: 'Studio' })
    expect(disposeSecondariesForConnection).toHaveBeenCalledWith('studio')
    expect(broadcastGatewaySwitch).toHaveBeenCalledWith('remote', { connectionId: 'studio', mode: 'remote' })
    expect(keepSession).toHaveBeenCalledTimes(1)
    expect($pendingConnectionId.get()).toBeNull()
  })

  it('holds a tunnel through the publish and lets it go last', async () => {
    const held = lease()

    rust(SSH)
    acquireTunnel.mockResolvedValue(held)

    await selectConnection('studio')

    expect(order).toEqual(['publish:studio', 'persist', 'dispose', 'broadcast', 'emit', 'release'])
    // The tunnel's own base, and no token: Rust attaches it by base.
    expect($activeConnection.get()?.connection).toEqual({
      authMode: 'token',
      baseUrl: 'http://127.0.0.1:41000',
      mode: 'ssh',
      profile: null,
      remoteHost: 'deploy@box'
    })
  })

  it('leaves the current source untouched when the preflight fails, and says nothing to anyone', async () => {
    onOld()
    order.length = 0
    authenticate.mockRejectedValue(new Error('Backend responded HTTP 502'))

    await expect(selectConnection('studio')).rejects.toThrow('Backend responded HTTP 502')

    expect($activeConnection.get()?.connectionId).toBe('old')
    expect(order).toEqual([])
    expect(invoke).not.toHaveBeenCalledWith('connections_set_last_used', expect.anything())
    expect($pendingConnectionId.get()).toBeNull()
  })

  it('throws a failed tunnel as copy, with what Rust said underneath', async () => {
    const refusal = { kind: 'credentials-needed', message: 'deploy@box: permission denied', terminal: true }

    onOld()
    rust(SSH)
    acquireTunnel.mockRejectedValue(refusal)

    const failure = await selectConnection('studio').catch((error: unknown) => error)

    expect((failure as Error).message).not.toContain('deploy@box')
    expect((failure as Error).cause).toBe(refusal)
    expect($activeConnection.get()?.connectionId).toBe('old')
  })

  // Only a person's click may put a question on screen (838bc8fd38, MJXHRM-592):
  // a login page — a one-way door on a phone — or an SSH passphrase / host key.
  it('preflights non-interactively unless the caller says a person asked', async () => {
    await selectConnection('studio')

    expect(authenticate).toHaveBeenCalledWith({
      allowInteractive: false,
      connectionId: 'studio',
      url: 'https://studio.test'
    })

    publishActiveConnection(null)
    await selectConnection('studio', { allowInteractive: true })

    expect(authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ allowInteractive: true }))
  })

  it('acquires an ssh tunnel interactively only when a person asked', async () => {
    rust(SSH)
    acquireTunnel.mockImplementation(async () => lease())

    await selectConnection('studio', { allowInteractive: true, attemptId: 'attempt-1' })

    expect(acquireTunnel).toHaveBeenLastCalledWith('studio', {
      attemptId: 'attempt-1',
      interactive: true,
      label: 'Studio'
    })

    publishActiveConnection(null)
    await selectConnection('studio')

    expect(acquireTunnel).toHaveBeenLastCalledWith('studio', expect.objectContaining({ interactive: false }))
  })

  it('renews a cloud agent session silently, and fails the switch when it cannot', async () => {
    rust({ ...RESOLVED, kind: 'cloud', mode: 'cloud' })
    oauthStatus.mockResolvedValue({ signedIn: false })
    portalAgentSignIn.mockResolvedValue({ baseUrl: RESOLVED.baseUrl, connected: true })

    await selectConnection('studio')

    expect($activeConnection.get()?.connection).toMatchObject({ authMode: 'oauth', mode: 'cloud' })

    publishActiveConnection(null)
    portalAgentSignIn.mockResolvedValue({ baseUrl: RESOLVED.baseUrl, connected: false })

    await expect(selectConnection('studio')).rejects.toThrow()
    expect($activeConnection.get()).toBeNull()
  })

  it('is a no-op except for lastUsed when the same source is re-clicked', async () => {
    await selectConnection('studio')
    order.length = 0
    authenticate.mockClear()

    await selectConnection('studio')

    // A re-dial would drop a live socket for nothing.
    expect(authenticate).not.toHaveBeenCalled()
    expect(order).toEqual(['persist'])
  })

  it('re-runs the switch onto the same source when its row was just saved', async () => {
    await selectConnection('studio')
    order.length = 0

    await selectConnection('studio', { reapply: true })

    expect(order).toEqual(['publish:studio', 'persist', 'dispose', 'broadcast', 'emit'])
  })

  it('lands on the profile the fleet rail named, the same source included', async () => {
    await selectConnection('studio')
    emitConnectionApplied.mockClear()

    await selectConnection('studio', { profile: 'work' })

    expect(invoke).toHaveBeenCalledWith('connections_resolve', { connectionId: 'studio', profile: 'work' })
    expect(lastProfileFor('studio')).toBe('work')
    expect(emitConnectionApplied).toHaveBeenCalledTimes(1)

    await selectConnection('studio', { profile: 'work' })

    expect(emitConnectionApplied).toHaveBeenCalledTimes(1)
  })

  it('refuses a LATCHED source and says why instead of re-entering the retry loop', async () => {
    $latchedConnections.set({ studio: 'host-key-changed' })

    await selectConnection('studio')

    expect(authenticate).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
  })

  it('does not let a set_last_used failure fail the switch', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'connections_set_last_used') {
        throw new Error('read-only disk')
      }

      return command === 'connections_resolve' ? RESOLVED : undefined
    })

    await expect(selectConnection('studio')).resolves.toBeUndefined()
    expect($activeConnection.get()?.connectionId).toBe('studio')
  })

  it('lets a LATER click own the outcome while an earlier preflight is pending', async () => {
    // Two clicks in flight. The revision guard is what stops the SLOWER one
    // from claiming the switch after the user already moved on.
    let openGate: () => void = () => {}

    const gate = new Promise<void>(resolve => {
      openGate = resolve
    })

    const slow = lease()

    acquireTunnel.mockImplementation(async () => {
      await gate

      return slow
    })
    invoke.mockImplementation(async (command: string, args: { connectionId?: string }) =>
      command === 'connections_resolve'
        ? { ...(args.connectionId === 'studio' ? SSH : RESOLVED), connectionId: args.connectionId, label: 'Row' }
        : undefined
    )

    const first = selectConnection('studio')
    const second = selectConnection(LOCAL_CONNECTION_ID)

    await second
    openGate()
    await first

    // The slow preflight passed, but its revision is stale: it publishes nothing,
    // remembers nothing, and still gives its tunnel back.
    expect($activeConnection.get()?.connectionId).toBe(LOCAL_CONNECTION_ID)
    expect(invoke).not.toHaveBeenCalledWith('connections_set_last_used', { connectionId: 'studio' })
    expect(emitConnectionApplied).toHaveBeenCalledTimes(1)
    expect(slow.release).toHaveBeenCalledTimes(1)
  })

  it('remembers the profile each source was last used on', async () => {
    await selectConnection('studio')

    expect(lastProfileFor('studio')).toBeNull() // 'default' is not remembered

    __testing.rememberProfile('studio', 'work')
    expect(lastProfileFor('studio')).toBe('work')
  })
})

// A peer window switched: same source here, by identity alone.
describe('followConnection', () => {
  beforeEach(() => {
    seedRegistry([LOCAL_CONNECTION_ID, 'studio'])
    onOld()
    order.length = 0
  })

  it('re-homes locally — no preflight, nothing remembered, nothing re-broadcast', async () => {
    await followConnection('studio')

    expect(order).toEqual(['publish:studio', 'dispose', 'emit'])
    expect(authenticate).not.toHaveBeenCalled()
    expect(acquireTunnel).not.toHaveBeenCalled()
    expect(keepSession).not.toHaveBeenCalled()
  })

  it('re-reads the last-profile store, which the switching window just wrote', async () => {
    // This page loaded before the other window remembered `work`.
    localStorage.setItem('hermes.connections.lastProfileByConnection', JSON.stringify({ studio: 'work' }))

    await followConnection('studio')

    expect(invoke).toHaveBeenCalledWith('connections_resolve', { connectionId: 'studio', profile: 'work' })
    expect(lastProfileFor('studio')).toBe('work')
  })

  it('does nothing when this window is already there', async () => {
    await followConnection('old')

    expect(order).toEqual([])
  })
})

// A connect form's Connect: desktop's applyConnectionConfig — save, then switch.
describe('applyConnection', () => {
  beforeEach(() => {
    seedRegistry(['studio'])
    invoke.mockImplementation(
      async (command: string, args: { connectionId?: string; input?: { id?: string } } = {}) => {
        if (command === 'connections_save') {
          return { connectionId: args.input?.id ?? 'minted', registry: $connectionsRegistry.get() }
        }

        if (command === 'connections_resolve') {
          return { ...RESOLVED, connectionId: args.connectionId }
        }

        return $connectionsRegistry.get()
      }
    )
  })

  it("saves onto the row that already points there, and switches as a person's click", async () => {
    await expect(
      applyConnection({ kind: 'remote', token: 'secret', url: 'studio.test/' }, { allowInteractive: true })
    ).resolves.toBe('minted')

    await applyConnection({ kind: 'remote', url: 'https://studio.test/' }, { allowInteractive: true })

    expect(invoke).toHaveBeenCalledWith('connections_resolve', { connectionId: 'studio', profile: null })
    expect(invoke).toHaveBeenCalledWith('connections_save', {
      input: { id: 'studio', kind: 'remote', label: 'studio', url: 'https://studio.test/' }
    })
    expect(authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ allowInteractive: true }))
  })

  it('mints a row for a new target, labelled by where it points, and never keeps the secret', async () => {
    await applyConnection({ kind: 'ssh', host: 'deploy@box:2222', password: 'hunter2' })

    expect(invoke).toHaveBeenCalledWith('connections_save', {
      input: { host: 'deploy@box:2222', id: undefined, kind: 'ssh', label: 'deploy@box', password: 'hunter2' }
    })
    expect(JSON.stringify($activeConnection.get())).not.toContain('hunter2')
  })

  it('switches again onto the source the window is already on: its credential may be new', async () => {
    await applyConnection({ kind: 'remote', url: 'https://studio.test' })
    emitConnectionApplied.mockClear()

    await applyConnection({ kind: 'remote', token: 'rotated', url: 'https://studio.test' })

    expect(emitConnectionApplied).toHaveBeenCalledTimes(1)
  })
})

// Desktop's writer over universal's per-source memory.
describe('the last-profile writer', () => {
  const descriptor = (profile?: string) => ({ connectionId: 'studio', ...(profile && { profile }) })

  it('reads the active source off the descriptor the fold published', () => {
    expect($activeConnectionId.get()).toBeNull()

    desktop.connection?.set(descriptor())

    expect($activeConnectionId.get()).toBe('studio')
  })

  it('remembers a profile once the descriptor confirms it, and not before', () => {
    desktop.connection?.set(descriptor())
    desktop.profile?.set('work')

    // The rail moved first; the socket is still the old profile's.
    expect(lastProfileFor('studio')).toBeNull()

    desktop.connection?.set(descriptor('work'))

    expect(lastProfileFor('studio')).toBe('work')
  })

  it('remembers the way back to default too', () => {
    __testing.rememberProfile('studio', 'work')
    desktop.connection?.set(descriptor())

    expect(lastProfileFor('studio')).toBeNull()
  })

  it('remembers nothing while no source is active', () => {
    desktop.profile?.set('work')

    expect(localStorage.getItem('hermes.connections.lastProfileByConnection')).toBeNull()
  })
})

// MJXHRM-592 (owner decision): a Connect's answer is kept where that row's own
// dials read it.
describe('saveTunnelAnswer', () => {
  function seedSsh(legacy: boolean): void {
    $connectionsRegistry.set({
      ...$connectionsRegistry.get(),
      connections: [
        {
          hasSshKey: true,
          hasSshPassphrase: false,
          hasSshPassword: false,
          hasToken: false,
          headerNames: [],
          host: 'box',
          id: 'box',
          keyPath: '~/.ssh/id_ed25519',
          kind: 'ssh',
          label: 'Box',
          legacy,
          order: 0,
          port: 2222,
          user: 'deploy'
        }
      ]
    })
  }

  beforeEach(() => mergeSshSecrets.mockClear())

  it('saves a registered row through the editor save, secrets only', async () => {
    seedSsh(false)
    invoke.mockImplementation(async (command: string) =>
      command === 'connections_save' ? { registry: $connectionsRegistry.get() } : undefined
    )

    await saveTunnelAnswer('box', { passphrase: 'open sesame' })

    expect(invoke).toHaveBeenCalledWith('connections_save', {
      input: expect.objectContaining({ host: 'box', id: 'box', kind: 'ssh', passphrase: 'open sesame', port: 2222 })
    })
    expect(mergeSshSecrets).not.toHaveBeenCalled()
  })

  it("writes the legacy owner's bare accounts, as the configurator does", async () => {
    seedSsh(true)

    await saveTunnelAnswer('box', { password: 'hunter2' })

    expect(mergeSshSecrets).toHaveBeenCalledWith({ password: 'hunter2' })
    expect(invoke).not.toHaveBeenCalledWith('connections_save', expect.anything())
  })
})
