import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two-phase switch (MJXHRM-602): preflight with the current source untouched,
// then publish → remember → persist → dispose → broadcast → emit → land →
// release. `order` records the commit as it happens, across every seam it crosses.
const {
  acquireTunnel,
  authenticate,
  broadcastGatewaySwitch,
  captureNewChatSource,
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
  requestFreshSession,
  takePendingOAuth
} = vi.hoisted(() => {
  const order: string[] = []

  return {
    acquireTunnel: vi.fn(),
    authenticate: vi.fn(),
    broadcastGatewaySwitch: vi.fn((..._args: unknown[]) => void order.push('broadcast')),
    desktop: {} as {
      connection?: { set(value: unknown): void }
      newChatProfile?: { get(): null | string; set(value: null | string): void }
      profile?: { set(value: string): void }
      showAllProfiles?: { get(): boolean; set(value: boolean): void }
    },
    captureNewChatSource: vi.fn(),
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
    requestFreshSession: vi.fn(() => void order.push('land')),
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
  desktop.newChatProfile = atom<null | string>(null)
  desktop.showAllProfiles = atom(false)

  return {
    $activeGatewayProfile: desktop.profile,
    $newChatProfile: desktop.newChatProfile,
    $showAllProfiles: desktop.showAllProfiles,
    captureNewChatSource,
    normalizeProfileKey: (name?: null | string) => (name ?? '').trim() || 'default',
    requestFreshSession
  }
})
vi.mock('@/store/session', async () => {
  const { atom } = await import('@/store/atom')

  desktop.connection = atom<unknown>(null)

  return { $connection: desktop.connection }
})

import { GatewaySignInRequiredError } from '@/gateway'
import { LOCAL_CONNECTION_ID } from '@/lib/backend-scope'
import { WEBVIEW_ID } from '@/lib/webview-id'

import { $activeConnection, describeConnection, publishActiveConnection } from './active-connection'
import { $latchedConnections, __resetConnectionLatches } from './connection-latches'
import {
  $activeConnectionId,
  $connectionsRegistry,
  $hasMultipleConnections,
  $lastProfileByConnection,
  $pendingConnectionId,
  __testing,
  applyConnection,
  followConnection,
  initializeConnectionsRegistry,
  isNewerCommit,
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
// `rememberProfile`, whose place BEFORE the broadcast and the emit is what a
// following peer's identity is built from.
$lastProfileByConnection.listen(() => void order.push('remember'))

/** A preflight held open until the test lets it land. */
function gated<T>(value: T): { open: () => void; pending: Promise<T> } {
  let open: () => void = () => {}

  const pending = new Promise<T>(resolve => {
    open = () => resolve(value)
  })

  return { open, pending }
}

/** The `(at, origin)` this window's last broadcast was stamped with. */
function lastStamp(): { at: number; origin: string } {
  return { at: broadcastGatewaySwitch.mock.lastCall?.[2] as number, origin: WEBVIEW_ID }
}

beforeEach(() => {
  vi.clearAllMocks()
  platform.tauri = true
  localStorage.clear()
  __testing.reset()
  __resetConnectionLatches()
  publishActiveConnection(null)
  desktop.connection?.set(null)
  desktop.profile?.set('default')
  desktop.newChatProfile?.set(null)
  desktop.showAllProfiles?.set(false)
  order.length = 0
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

  // ONE derivation (finding 6): the identity carries the profile the socket, the
  // scope key and `profile.get` all read, so it is built with the last-used one —
  // and, never used, with the row's own, which only Rust knows.
  it('builds the launch identity with the profile the source was last used on', async () => {
    seedRegistry(['home'])
    __testing.rememberProfile('home', 'work')

    await restoreLaunchConnection(true)

    expect(invoke).toHaveBeenCalledWith('connections_resolve', { connectionId: 'home', profile: 'work' })
    expect($activeConnection.get()).toMatchObject({ profile: 'work', scopeKey: 'conn:home::work' })
  })

  it("takes a never-used row's own profile from Rust, and keeps `default` once a person chose it", async () => {
    seedRegistry(['box'])
    // Rust's fallback: no profile named → the row's `remote_profile`.
    invoke.mockImplementation(async (command: string, args: { connectionId?: string; profile?: null | string } = {}) =>
      command === 'connections_resolve'
        ? {
            ...SSH,
            connectionId: args.connectionId,
            dialConnectionId: args.connectionId,
            profile: args.profile ?? 'work'
          }
        : $connectionsRegistry.get()
    )

    await restoreLaunchConnection(true)

    expect($activeConnection.get()?.profile).toBe('work')

    __testing.reset()
    seedRegistry(['box'])
    publishActiveConnection(null)
    __testing.rememberProfile('box', 'default')

    await restoreLaunchConnection(true)

    expect(invoke).toHaveBeenCalledWith('connections_resolve', { connectionId: 'box', profile: 'default' })
    expect($activeConnection.get()?.profile).toBe('default')
  })

  // Launch mode `primary`: a window booting alongside the owner read `lastUsed`
  // before the owner's write landed, and sits on the old source.
  it('tells the other windows where the owner launched, once the write has landed, when the launch mode moved it', async () => {
    seedRegistry(['home', 'studio'], { lastUsed: 'studio', launchMode: 'primary' })

    const write = gated($connectionsRegistry.get())

    invoke.mockImplementation(async (command: string, args: { connectionId?: string } = {}) => {
      if (command === 'connections_resolve') {
        return { ...RESOLVED, connectionId: args.connectionId, dialConnectionId: args.connectionId }
      }

      return command === 'connections_set_last_used' ? write.pending : $connectionsRegistry.get()
    })

    await restoreLaunchConnection(true)

    expect($activeConnection.get()?.connectionId).toBe('home')
    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()

    write.open()
    await vi.waitFor(() => expect(broadcastGatewaySwitch).toHaveBeenCalledTimes(1))

    expect(broadcastGatewaySwitch).toHaveBeenCalledWith(
      'remote',
      { connectionId: 'home', mode: 'remote' },
      expect.any(Number)
    )
  })

  it('says nothing when the owner launched where every window reads', async () => {
    seedRegistry(['home', 'studio'], { lastUsed: 'studio' })

    await restoreLaunchConnection(true)
    await Promise.resolve()

    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
  })

  it("converges a window that launched on the stale source onto the owner's launch", async () => {
    seedRegistry(['home', 'studio'], { lastUsed: 'studio', launchMode: 'primary' })

    await restoreLaunchConnection(false)

    expect($activeConnection.get()?.connectionId).toBe('studio')

    // The owner's launch commit, as the sync listener hands it over.
    await followConnection('home', { at: Date.now(), origin: 'owner' })

    expect($activeConnection.get()?.connectionId).toBe('home')
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

  it('commits in order: publish → remember → persist → dispose → broadcast → emit → land', async () => {
    await selectConnection('studio')

    // `remember` before `broadcast` and `emit`: a following peer builds its
    // identity from that memory.
    expect(order).toEqual(['publish:studio', 'remember', 'persist', 'dispose', 'broadcast', 'emit', 'land'])
    expect($activeConnection.get()).toMatchObject({ connectionId: 'studio', label: 'Studio' })
    expect(disposeSecondariesForConnection).toHaveBeenCalledWith('studio')
    expect(broadcastGatewaySwitch).toHaveBeenCalledWith(
      'remote',
      { connectionId: 'studio', mode: 'remote' },
      expect.any(Number)
    )
    expect(keepSession).toHaveBeenCalledTimes(1)
    expect($pendingConnectionId.get()).toBeNull()
  })

  it('holds a tunnel through the publish and lets it go last', async () => {
    const held = lease()

    rust(SSH)
    acquireTunnel.mockResolvedValue(held)

    await selectConnection('studio')

    expect(order).toEqual(['publish:studio', 'remember', 'persist', 'dispose', 'broadcast', 'emit', 'land', 'release'])
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
    // What a connect form branches on, and none of Rust's text.
    expect((failure as Error).cause).toEqual({ kind: 'credentials-needed', sshKind: undefined, terminal: true })
    expect(JSON.stringify((failure as Error).cause)).not.toContain('deploy@box')
    expect($activeConnection.get()?.connectionId).toBe('old')
  })

  // Desktop's switcher, profile rail and settings call a bare `selectConnection(id)`,
  // and every one of them is a click: a person may be asked a question — a login
  // page, an SSH passphrase or host key. Only a caller that is NOT a person opts out.
  it("preflights a bare call as a person's click", async () => {
    await selectConnection('studio')

    expect(authenticate).toHaveBeenCalledWith({
      allowInteractive: true,
      connectionId: 'studio',
      url: 'https://studio.test'
    })

    publishActiveConnection(null)
    await selectConnection('studio', { allowInteractive: false })

    expect(authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ allowInteractive: false }))
  })

  it('acquires an ssh tunnel interactively for a bare call, and in the background only when told', async () => {
    rust(SSH)
    acquireTunnel.mockImplementation(async () => lease())

    await selectConnection('studio')

    expect(acquireTunnel).toHaveBeenLastCalledWith('studio', expect.objectContaining({ interactive: true }))

    publishActiveConnection(null)
    await selectConnection('studio', { attemptId: 'attempt-1' })

    expect(acquireTunnel).toHaveBeenLastCalledWith('studio', {
      attemptId: 'attempt-1',
      interactive: true,
      label: 'Studio'
    })

    publishActiveConnection(null)
    await selectConnection('studio', { allowInteractive: false })

    expect(acquireTunnel).toHaveBeenLastCalledWith('studio', expect.objectContaining({ interactive: false }))
  })

  // Finding 5: a rejected `invoke` is a bare Rust string that quotes the URL.
  it('throws a URL preflight failure as copy, never as the text Rust gave', async () => {
    onOld()
    authenticate.mockRejectedValue('error sending request for url (https://studio.test/api/status)')

    const failure = (await selectConnection('studio').catch((error: unknown) => error)) as Error

    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe('Could not reach this gateway.')
    expect(failure.cause).toBeUndefined()
    expect($activeConnection.get()?.connectionId).toBe('old')
  })

  it('throws a cloud preflight failure as copy too, whether it rejected or could not tell', async () => {
    rust({ ...RESOLVED, kind: 'cloud', mode: 'cloud' })
    oauthStatus.mockRejectedValue('error sending request for url (https://studio.test/api/auth/me)')

    await expect(selectConnection('studio')).rejects.toThrow('Could not reach this gateway.')

    oauthStatus.mockResolvedValue({ error: 'dns error: studio.test', reachable: false, signedIn: false })

    const failure = (await selectConnection('studio').catch((error: unknown) => error)) as Error

    expect(failure.message).toBe('Could not reach this gateway.')
    expect(failure.cause).toBeUndefined()
  })

  it('keeps a typed preflight error intact', async () => {
    const needsSignIn = new GatewaySignInRequiredError('Hermes needs you to sign in')

    authenticate.mockRejectedValue(needsSignIn)

    await expect(selectConnection('studio')).rejects.toBe(needsSignIn)
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

    expect(order).toEqual(['publish:studio', 'remember', 'persist', 'dispose', 'broadcast', 'emit', 'land'])
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

  // Finding 3: on `old`, click studio (a slow SSH preflight), click `old` to back out.
  it('cancels a pending switch when the current source is re-clicked, and still returns its tunnel', async () => {
    const slow = lease()
    const gate = gated(slow)

    onOld()
    order.length = 0
    rust(SSH)
    acquireTunnel.mockImplementation(() => gate.pending)

    const pending = selectConnection('studio')

    await vi.waitFor(() => expect(acquireTunnel).toHaveBeenCalled())
    expect($pendingConnectionId.get()).toBe('studio')

    await selectConnection('old')

    expect($pendingConnectionId.get()).toBeNull()

    gate.open()
    await pending

    expect($activeConnection.get()?.connectionId).toBe('old')
    expect(emitConnectionApplied).not.toHaveBeenCalled()
    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
    expect(slow.release).toHaveBeenCalledTimes(1)
  })

  // Desktop's: a superseded switch's failure belongs to nobody.
  it('says nothing about the failure of a switch the person backed out of', async () => {
    let fail: (reason: unknown) => void = () => {}

    onOld()
    rust(SSH)
    acquireTunnel.mockImplementation(() => new Promise((_resolve, reject) => void (fail = reject)))

    const pending = selectConnection('studio')

    await vi.waitFor(() => expect(acquireTunnel).toHaveBeenCalled())
    await selectConnection('old')
    fail({ kind: 'cancelled', terminal: true })

    await expect(pending).resolves.toBeUndefined()
  })

  // Finding 4: the follow bumps the revision, so the select's `finally` steps aside.
  it("takes the spinner down when a peer's switch supersedes a local one", async () => {
    const gate = gated(lease())

    onOld()
    seedRegistry([LOCAL_CONNECTION_ID, 'studio', 'lab'])
    invoke.mockImplementation(async (command: string, args: { connectionId?: string } = {}) =>
      command === 'connections_resolve'
        ? { ...(args.connectionId === 'studio' ? SSH : RESOLVED), connectionId: args.connectionId }
        : undefined
    )
    acquireTunnel.mockImplementation(() => gate.pending)

    const pending = selectConnection('studio')

    await vi.waitFor(() => expect(acquireTunnel).toHaveBeenCalled())
    await followConnection('lab')

    expect($pendingConnectionId.get()).toBeNull()

    gate.open()
    await pending

    expect($pendingConnectionId.get()).toBeNull()
    expect($activeConnection.get()?.connectionId).toBe('lab')
  })

  // 8i — desktop's select also lands the window on its target, so nothing of
  // the source it left outlives the switch.
  it("leaves browse mode and points new chats at the target, as desktop's select does", async () => {
    desktop.showAllProfiles?.set(true)
    desktop.newChatProfile?.set('a-profile-studio-lacks')

    await selectConnection('studio', { profile: 'work' })

    expect(desktop.showAllProfiles?.get()).toBe(false)
    expect(desktop.newChatProfile?.get()).toBe('work')
    // Named: the fold re-dials after this, so its active route is still the old one.
    expect(captureNewChatSource).toHaveBeenCalledWith('studio')
    expect(requestFreshSession).toHaveBeenCalledTimes(1)
  })

  it('leaves browse mode on a re-click of the current source, and only then starts a fresh chat', async () => {
    await selectConnection('studio')
    vi.mocked(requestFreshSession).mockClear()

    await selectConnection('studio')

    expect(requestFreshSession).not.toHaveBeenCalled()

    desktop.showAllProfiles?.set(true)
    await selectConnection('studio')

    expect(desktop.showAllProfiles?.get()).toBe(false)
    expect(captureNewChatSource).toHaveBeenLastCalledWith('studio')
    expect(requestFreshSession).toHaveBeenCalledTimes(1)
    expect(emitConnectionApplied).toHaveBeenCalledTimes(1)
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

    // (`remember` would be the re-read of the profile memory, which is not a write.)
    expect(order.filter(step => step !== 'remember')).toEqual(['publish:studio', 'dispose', 'emit', 'land'])
    expect(localStorage.getItem('hermes.connections.lastProfileByConnection')).toBeNull()
    expect(desktop.newChatProfile?.get()).toBe('default')
    expect(captureNewChatSource).toHaveBeenCalledWith('studio')
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

// 8b — two windows select different rows within milliseconds: each publishes and
// broadcasts, then each hears the other. Without an order they swap.
describe('two crossed switches', () => {
  beforeEach(() => {
    seedRegistry([LOCAL_CONNECTION_ID, 'studio', 'lab'])
    invoke.mockImplementation(async (command: string, args: { connectionId?: string } = {}) =>
      command === 'connections_resolve' ? { ...RESOLVED, connectionId: args.connectionId } : undefined
    )
  })

  it('orders any two commits the same way at both ends', () => {
    const early = { at: 100, origin: 'b' }
    const late = { at: 101, origin: 'a' }

    expect(isNewerCommit(late, early)).toBe(true)
    expect(isNewerCommit(early, late)).toBe(false)
    // The same instant: the origin decides, and only one of the pair is newer.
    expect(isNewerCommit({ at: 100, origin: 'b' }, { at: 100, origin: 'a' })).toBe(true)
    expect(isNewerCommit({ at: 100, origin: 'a' }, { at: 100, origin: 'b' })).toBe(false)
    expect(isNewerCommit(early, early)).toBe(false)
  })

  it('ignores the older half of a crossed pair, and follows the newer one', async () => {
    await selectConnection('studio')

    const mine = lastStamp()

    // The peer committed `lab` BEFORE this window committed `studio`; its
    // broadcast crossed ours. This window is the later one: it stays, and the
    // peer — comparing the same two stamps — follows `studio`.
    await followConnection('lab', { at: mine.at - 1, origin: 'peer' })

    expect($activeConnection.get()?.connectionId).toBe('studio')

    // The same instant: the origin breaks the tie, the same way at both ends.
    await followConnection('lab', { at: mine.at, origin: '' })

    expect($activeConnection.get()?.connectionId).toBe('studio')

    await followConnection('lab', { at: mine.at, origin: `${mine.origin}~` })

    expect($activeConnection.get()?.connectionId).toBe('lab')
  })

  it('stamps a commit made after hearing a peer as newer than it, whatever the clock says', async () => {
    const future = Date.now() + 60_000

    await followConnection('lab', { at: future, origin: 'peer' })
    await selectConnection('studio')

    expect(lastStamp().at).toBeGreaterThan(future)
    expect(isNewerCommit(lastStamp(), { at: future, origin: 'peer' })).toBe(true)
  })

  it('does not replay a follow it has already heard', async () => {
    await followConnection('lab', { at: 500, origin: 'peer' })
    onOld()
    await followConnection('lab', { at: 500, origin: 'peer' })

    expect($activeConnection.get()?.connectionId).toBe('old')
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
