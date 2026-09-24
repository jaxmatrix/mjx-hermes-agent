import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two-phase switch (MJXHRM-602): preflight with the current source untouched,
// then remember → commit (Rust) → publish → dispose → emit → land → release.
// `order` records the commit as it happens, across every seam it crosses. One
// window here; several over one core are `connections-windows.test.ts`.
const {
  acquireTunnel,
  authenticate,
  captureNewChatSource,
  claimPendingOAuth,
  desktop,
  disposeSecondariesForConnection,
  emitConnectionApplied,
  invoke,
  keepSession,
  keepTunnelAnswers,
  listen,
  mergeSshSecrets,
  notify,
  oauthStatus,
  order,
  platform,
  portalAgentSignIn,
  requestFreshSession,
  rustSource
} = vi.hoisted(() => {
  const order: string[] = []

  return {
    acquireTunnel: vi.fn(),
    authenticate: vi.fn(),
    claimPendingOAuth: vi.fn(),
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
    listen: vi.fn(async (..._args: unknown[]): Promise<unknown> => vi.fn()),
    keepTunnelAnswers: vi.fn((_connectionId: string, attemptId = 'attempt-kept') => ({ attemptId, stop: vi.fn() })),
    mergeSshSecrets: vi.fn(async () => true),
    notify: vi.fn(),
    oauthStatus: vi.fn(),
    order,
    platform: { tauri: true },
    portalAgentSignIn: vi.fn(),
    requestFreshSession: vi.fn(() => void order.push('land')),
    /** Rust's book, as far as one window goes: where the app is, and the order. */
    rustSource: { connectionId: null as null | string, dialSeq: 1, seq: 1 }
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@/hermes', () => ({
  getApiRequestConnection: () => null,
  getApiRequestProfile: () => 'default',
  setApiRequestProfile: vi.fn()
}))
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
  keepTunnelAnswers,
  liveTunnelBase: vi.fn(() => null),
  setTunnelAnswerSaver: vi.fn()
}))
// Desktop's registry and the two atoms its last-profile writer reads.
vi.mock('@/store/gateway', () => ({ disposeSecondariesForConnection }))
vi.mock('@/store/gateway-restore', async () => {
  const { atom } = await import('@/store/atom')

  return { $restoring: atom(true), claimPendingOAuth, loadGatewayTarget: () => null }
})
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

import { $activeConnection, describeConnection, publishActiveConnection } from './active-connection'
import { $latchedConnections, __resetConnectionLatches } from './connection-latches'
import {
  $activeConnectionId,
  $connectionsRegistry,
  $hasMultipleConnections,
  $lastProfileByConnection,
  $pendingConnectionId,
  $registryView,
  __testing,
  applyConnection,
  applySource,
  initializeConnectionsRegistry,
  lastProfileFor,
  loadConnectionsRegistry,
  refreshConnectionsRegistry,
  restoreLaunchConnection,
  saveTunnelAnswer,
  selectConnection,
  setConnectionsRegistry,
  startConnectionsWatcher
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
  $registryView.set({
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

/** Rust's two source commands: where the app is, and a commit's next `seq`. */
function rustSourceCommand(command: string, connectionId?: string): null | typeof rustSource {
  if (command === 'connections_commit_source') {
    order.push('commit')

    const moved = rustSource.connectionId !== connectionId

    rustSource.seq += 1
    rustSource.dialSeq = moved ? rustSource.seq : rustSource.dialSeq
    rustSource.connectionId = connectionId ?? null
  }

  return command === 'connections_commit_source' || command === 'connections_current_source' ? { ...rustSource } : null
}

/** Rust, as far as these tests go: the roster it holds, one resolvable row, the source. */
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

    return (
      rustSourceCommand(command, args.connectionId) ??
      (command.startsWith('connections_') ? $registryView.get() : undefined)
    )
  })
}

/** Where Rust says the app is, for the launch read. */
function appIsOn(connectionId: null | string): void {
  Object.assign(rustSource, { connectionId, dialSeq: 1, seq: 1 })
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

/** On `old` the way a window gets anywhere: Rust said so, and it applied it. */
async function onOldAsRustHasIt(): Promise<void> {
  Object.assign(rustSource, { connectionId: 'old', dialSeq: 2, seq: 2 })
  await applySource({ ...rustSource })
  vi.clearAllMocks()
  order.length = 0
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
  appIsOn(null)
  claimPendingOAuth.mockResolvedValue(null)
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

// Desktop's switcher, profile rail, settings and sidebar groups read ITS atom
// (`store/connection-registry-state`), in its shape. It is a projection of
// Rust's view: one registry, two shapes, never two truths.
describe("desktop's registry atom", () => {
  it('is null until a view arrives, then follows every write of it, in desktop’s shape', () => {
    expect($connectionsRegistry.get()).toBeNull()

    seedRegistry(['home', 'studio'])

    expect($connectionsRegistry.get()).toEqual({
      connections: [
        {
          headerNames: [],
          id: 'home',
          kind: 'remote',
          label: 'home',
          tokenPreview: null,
          tokenSet: false,
          url: 'https://home.test'
        },
        {
          headerNames: [],
          id: 'studio',
          kind: 'remote',
          label: 'studio',
          tokenPreview: null,
          tokenSet: false,
          url: 'https://studio.test'
        }
      ],
      lastUsed: 'home',
      launchMode: 'last-used',
      primary: 'home',
      secureTokenStorage: true,
      version: 2
    })

    seedRegistry(['home'])

    expect($connectionsRegistry.get()?.connections.map(row => row.id)).toEqual(['home'])
  })

  it('answers desktop’s refresh in desktop’s shape, and goes back to null on a reset', async () => {
    seedRegistry(['home'])
    rust()

    expect(await refreshConnectionsRegistry()).toEqual($connectionsRegistry.get())
    expect((await initializeConnectionsRegistry())?.primary).toBe('home')

    __testing.reset()

    expect($connectionsRegistry.get()).toBeNull()
  })

  it('takes what desktop’s registry page publishes without touching Rust’s view', () => {
    seedRegistry(['home'])

    const view = $registryView.get()

    setConnectionsRegistry({ connections: [], lastUsed: 'x', primary: 'x', secureTokenStorage: true, version: 2 })

    expect($connectionsRegistry.get()?.primary).toBe('x')
    expect($registryView.get()).toBe(view)
  })
})

describe('loadConnectionsRegistry', () => {
  it('seeds and publishes the roster without dialling, and reports a degraded one once', async () => {
    seedRegistry(['home', 'studio'])

    const registry = { ...$registryView.get(), degraded: true }

    __testing.reset()
    invoke.mockImplementation(async () => registry)

    await loadConnectionsRegistry()
    await loadConnectionsRegistry()

    expect(invoke).toHaveBeenCalledWith('connections_migrate', { legacyTarget: null })
    expect($registryView.get()).toBe(registry)
    expect(notify).toHaveBeenCalledTimes(1)
    expect($activeConnection.get()).toBeNull()
  })
})

// Boot: W0 → W1 by identity alone. Desktop's fold dials through the bridge. WHERE
// is Rust's to say (`source.rs`, and its tests): no window decides its launch.
describe('restoreLaunchConnection', () => {
  it('publishes the source the app is on without a preflight, a dial or a commit', async () => {
    seedRegistry(['home', 'studio'])
    appIsOn('studio')

    await restoreLaunchConnection(true)

    expect(invoke).toHaveBeenCalledWith('connections_migrate', { legacyTarget: null })
    expect($activeConnection.get()).toMatchObject({
      connection: { authMode: 'none', baseUrl: 'https://studio.test', mode: 'remote' },
      connectionId: 'studio'
    })
    expect(authenticate).not.toHaveBeenCalled()
    expect(acquireTunnel).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('connections_commit_source', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('connections_set_last_used', expect.anything())
    // An identity, not a switch: the boot hook has not dialled, so there is
    // nothing to wipe, re-dial or start afresh.
    // (`remember` is the re-read of the profile memory, which is not a write.)
    expect(order.filter(step => step !== 'remember')).toEqual(['publish:studio'])
    expect(emitConnectionApplied).not.toHaveBeenCalled()
    expect($restoring.get()).toBe(false)
  })

  it("publishes a tunnelled source with no address: its base is the dial's to find", async () => {
    seedRegistry(['box'])
    appIsOn('box')
    rust(SSH)

    await restoreLaunchConnection(true)

    expect($activeConnection.get()?.connection).toMatchObject({ authMode: 'token', baseUrl: '', mode: 'ssh' })
    expect($activeConnection.get()?.connection.token).toBeUndefined()
    expect(acquireTunnel).not.toHaveBeenCalled()
  })

  // B1: "New window" owns app state too. It used to honour the launch mode and
  // drag every window off the source the person chose.
  it("never decides the launch itself: the launch mode is not this window's to read, owner or not", async () => {
    for (const owner of [true, false]) {
      __testing.reset()
      publishActiveConnection(null)
      invoke.mockClear()
      seedRegistry(['home', 'studio'], { lastUsed: 'home', launchMode: 'primary', primary: 'home' })
      appIsOn('studio')

      await restoreLaunchConnection(owner)

      expect($activeConnection.get()?.connectionId).toBe('studio')
      expect(invoke).toHaveBeenCalledWith(owner ? 'connections_migrate' : 'connections_list', expect.anything())
      expect(invoke).not.toHaveBeenCalledWith(owner ? 'connections_list' : 'connections_migrate', expect.anything())
      expect(invoke).not.toHaveBeenCalledWith('connections_commit_source', expect.anything())
      expect(invoke).not.toHaveBeenCalledWith('connections_set_last_used', expect.anything())
    }
  })

  // A phone cannot run a backend, so a fresh one has no row at all.
  it('stays unconfigured on a phone with nothing configured', async () => {
    seedRegistry([], { localSupported: false })
    appIsOn(null)

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

  // A commit between "listening" and "read" would otherwise be in neither.
  it('reads where the app is only once it is listening for where it goes next', async () => {
    const listening = gated(vi.fn())

    seedRegistry(['home'])
    appIsOn('home')
    listen.mockImplementationOnce(() => listening.pending)
    startConnectionsWatcher()

    const launching = restoreLaunchConnection(true)

    await Promise.resolve()
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()

    listening.open()
    await launching

    expect(invoke).toHaveBeenCalledWith('connections_current_source', {})
    expect($activeConnection.get()?.connectionId).toBe('home')
  })

  it('changes nothing when the window has already heard of a newer source than the one it read', async () => {
    seedRegistry(['home', 'studio'])
    appIsOn('home')

    await applySource({ connectionId: 'studio', dialSeq: 5, seq: 5 })
    await restoreLaunchConnection(true)

    expect($activeConnection.get()?.connectionId).toBe('studio')
  })

  it('finishes the switch a mobile sign-in navigated away from, on the row it was for', async () => {
    seedRegistry(['home', 'studio'])
    appIsOn('home')
    claimPendingOAuth.mockResolvedValue({ base: 'https://studio.test', connectionId: 'studio' })
    oauthStatus.mockResolvedValue({ signedIn: true })

    await restoreLaunchConnection(true)

    expect($activeConnection.get()?.connectionId).toBe('studio')
    // The interrupted click, completed: never interactive, and a commit like
    // any other — so every window follows it.
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({ allowInteractive: false }))
    expect(invoke).toHaveBeenCalledWith('connections_commit_source', { connectionId: 'studio' })
    expect(invoke).not.toHaveBeenCalledWith('connections_current_source', expect.anything())
  })

  it('launches normally when that sign-in was abandoned', async () => {
    seedRegistry(['home', 'studio'])
    appIsOn('home')
    claimPendingOAuth.mockResolvedValue({ base: 'https://studio.test', connectionId: 'studio' })
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
    appIsOn('home')
    __testing.rememberProfile('home', 'work')

    await restoreLaunchConnection(true)

    expect(invoke).toHaveBeenCalledWith('connections_resolve', { connectionId: 'home', profile: 'work' })
    expect($activeConnection.get()).toMatchObject({ profile: 'work', scopeKey: 'conn:home::work' })
  })

  it("takes a never-used row's own profile from Rust, and keeps `default` once a person chose it", async () => {
    seedRegistry(['box'])
    appIsOn('box')
    // Rust's fallback: no profile named → the row's `remote_profile`.
    invoke.mockImplementation(async (command: string, args: { connectionId?: string; profile?: null | string } = {}) =>
      command === 'connections_resolve'
        ? {
            ...SSH,
            connectionId: args.connectionId,
            dialConnectionId: args.connectionId,
            profile: args.profile ?? 'work'
          }
        : (rustSourceCommand(command, args.connectionId) ?? $registryView.get())
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

  it('commits in order: remember → commit → publish → dispose → emit → land', async () => {
    await selectConnection('studio')

    // `remember` before `commit`: Rust tells the peers as it commits, and a peer
    // builds its identity from that memory.
    expect(order).toEqual(['remember', 'commit', 'publish:studio', 'dispose', 'emit', 'land'])
    expect($activeConnection.get()).toMatchObject({ connectionId: 'studio', label: 'Studio' })
    expect(disposeSecondariesForConnection).toHaveBeenCalledWith('studio')
    expect(invoke).toHaveBeenCalledWith('connections_commit_source', { connectionId: 'studio' })
    // Remembering the row is the commit's, in Rust. Nothing here writes it.
    expect(invoke).not.toHaveBeenCalledWith('connections_set_last_used', expect.anything())
    expect(keepSession).toHaveBeenCalledTimes(1)
    expect($pendingConnectionId.get()).toBeNull()
  })

  it('holds a tunnel through the publish and lets it go last', async () => {
    const held = lease()

    rust(SSH)
    acquireTunnel.mockResolvedValue(held)

    await selectConnection('studio')

    expect(order).toEqual(['remember', 'commit', 'publish:studio', 'dispose', 'emit', 'land', 'release'])
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
    expect(invoke).not.toHaveBeenCalledWith('connections_commit_source', expect.anything())
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

  // S2: a switcher click prompted for the passphrase and kept nothing, so Rust's
  // first background redial after its linger was refused as needing a person.
  it('keeps what a person answers an interactive tunnel preflight, for as long as that dial', async () => {
    const stop = vi.fn(() => void order.push('stop-keeping'))

    rust(SSH)
    acquireTunnel.mockImplementation(async () => (order.push('dial'), lease()))
    keepTunnelAnswers.mockImplementation((_connectionId: string, attemptId = 'attempt-kept') => ({ attemptId, stop }))

    await selectConnection('studio')

    // Listening under the attempt the dial prompts on, before it starts.
    expect(keepTunnelAnswers).toHaveBeenCalledExactlyOnceWith('studio', undefined)
    expect(acquireTunnel).toHaveBeenLastCalledWith('studio', {
      attemptId: 'attempt-kept',
      interactive: true,
      label: 'Studio'
    })
    expect(order.slice(0, 2)).toEqual(['dial', 'stop-keeping'])

    // A failed dial stops listening too…
    publishActiveConnection(null)
    acquireTunnel.mockRejectedValue({ kind: 'cancelled', terminal: true })
    await selectConnection('studio', { attemptId: 'attempt-1' }).catch(() => {})

    expect(keepTunnelAnswers).toHaveBeenLastCalledWith('studio', 'attempt-1')
    expect(stop).toHaveBeenCalledTimes(2)

    // …and a dial nobody is behind cannot be asked anything, so keeps nothing.
    keepTunnelAnswers.mockClear()
    await selectConnection('studio', { allowInteractive: false }).catch(() => {})

    expect(keepTunnelAnswers).not.toHaveBeenCalled()
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

  it('re-commits the row and does nothing else when the same source is re-clicked', async () => {
    await selectConnection('studio')
    order.length = 0
    authenticate.mockClear()

    await selectConnection('studio')

    // A re-dial would drop a live socket for nothing. Still a commit: Rust
    // remembers the row, and a peer's switch on its way here loses to the click.
    expect(authenticate).not.toHaveBeenCalled()
    expect(order).toEqual(['commit'])
    expect(rustSource).toEqual({ connectionId: 'studio', dialSeq: 2, seq: 3 })
  })

  it('re-runs the switch onto the same source when its row was just saved', async () => {
    await selectConnection('studio')
    order.length = 0

    await selectConnection('studio', { reapply: true })

    expect(order).toEqual(['remember', 'commit', 'publish:studio', 'dispose', 'emit', 'land'])
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

  // A full disk is Rust's to swallow (`commit_source`). What it REFUSES — the row
  // went while the preflight ran — fails the switch, and never in Rust's words.
  it("fails the switch in this app's words when Rust refuses the commit", async () => {
    onOld()
    invoke.mockImplementation(async (command: string) => {
      if (command === 'connections_commit_source') {
        throw { kind: 'not-found', message: 'no gateway with id "studio"' }
      }

      return command === 'connections_resolve' ? RESOLVED : undefined
    })

    const failure = (await selectConnection('studio').catch((error: unknown) => error)) as Error

    expect(failure.message).toBe('Could not reach this gateway.')
    expect(failure.cause).toBeUndefined()
    expect($activeConnection.get()?.connectionId).toBe('old')
    expect($pendingConnectionId.get()).toBeNull()
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
        : (rustSourceCommand(command, args?.connectionId) ?? undefined)
    )

    const first = selectConnection('studio')
    const second = selectConnection(LOCAL_CONNECTION_ID)

    await second
    openGate()
    await first

    // The slow preflight passed, but its revision is stale: it publishes nothing,
    // remembers nothing, and still gives its tunnel back.
    expect($activeConnection.get()?.connectionId).toBe(LOCAL_CONNECTION_ID)
    expect(invoke).not.toHaveBeenCalledWith('connections_commit_source', { connectionId: 'studio' })
    expect(emitConnectionApplied).toHaveBeenCalledTimes(1)
    expect(slow.release).toHaveBeenCalledTimes(1)
  })

  // Finding 3: on `old`, click studio (a slow SSH preflight), click `old` to back out.
  it('cancels a pending switch when the current source is re-clicked, and still returns its tunnel', async () => {
    const slow = lease()
    const gate = gated(slow)

    await onOldAsRustHasIt()
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
    expect(invoke).not.toHaveBeenCalledWith('connections_commit_source', { connectionId: 'studio' })
    expect(slow.release).toHaveBeenCalledTimes(1)
  })

  // Desktop's: a superseded switch's failure belongs to nobody.
  it('says nothing about the failure of a switch the person backed out of', async () => {
    let fail: (reason: unknown) => void = () => {}

    await onOldAsRustHasIt()
    rust(SSH)
    acquireTunnel.mockImplementation(() => new Promise((_resolve, reject) => void (fail = reject)))

    const pending = selectConnection('studio')

    await vi.waitFor(() => expect(acquireTunnel).toHaveBeenCalled())
    await selectConnection('old')
    fail({ kind: 'cancelled', terminal: true })

    await expect(pending).resolves.toBeUndefined()
  })

  // Finding 4: the apply supersedes the preflight, so the select's `finally` steps aside.
  it("takes the spinner down when a peer's commit supersedes a local switch", async () => {
    const gate = gated(lease())

    onOld()
    seedRegistry([LOCAL_CONNECTION_ID, 'studio', 'lab'])
    invoke.mockImplementation(async (command: string, args: { connectionId?: string } = {}) =>
      command === 'connections_resolve'
        ? { ...(args.connectionId === 'studio' ? SSH : RESOLVED), connectionId: args.connectionId }
        : (rustSourceCommand(command, args.connectionId) ?? undefined)
    )
    acquireTunnel.mockImplementation(() => gate.pending)

    const pending = selectConnection('studio')

    await vi.waitFor(() => expect(acquireTunnel).toHaveBeenCalled())
    await applySource({ connectionId: 'lab', dialSeq: 9, seq: 9 })

    expect($pendingConnectionId.get()).toBeNull()

    gate.open()
    await pending

    expect($pendingConnectionId.get()).toBeNull()
    expect($activeConnection.get()?.connectionId).toBe('lab')
    // The superseded preflight passed, and committed nothing.
    expect(invoke).not.toHaveBeenCalledWith('connections_commit_source', expect.anything())
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

// Rust committed a source this window did not: same source here, by identity alone.
describe('applySource', () => {
  beforeEach(() => {
    seedRegistry([LOCAL_CONNECTION_ID, 'studio', 'lab'])
    invoke.mockImplementation(async (command: string, args: { connectionId?: string; profile?: string } = {}) =>
      command === 'connections_resolve'
        ? { ...RESOLVED, connectionId: args.connectionId, profile: args.profile ?? undefined }
        : undefined
    )
    onOld()
    order.length = 0
  })

  it('re-homes locally — no preflight, nothing remembered, no commit', async () => {
    await expect(applySource({ connectionId: 'studio', dialSeq: 2, seq: 2 })).resolves.toBe(true)

    // (`remember` would be the re-read of the profile memory, which is not a write.)
    expect(order.filter(step => step !== 'remember')).toEqual(['publish:studio', 'dispose', 'emit', 'land'])
    expect(localStorage.getItem('hermes.connections.lastProfileByConnection')).toBeNull()
    expect(desktop.newChatProfile?.get()).toBe('default')
    expect(captureNewChatSource).toHaveBeenCalledWith('studio')
    expect(authenticate).not.toHaveBeenCalled()
    expect(acquireTunnel).not.toHaveBeenCalled()
    expect(keepSession).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('connections_commit_source', expect.anything())
  })

  it('re-reads the last-profile store, which the switching window just wrote', async () => {
    // This page loaded before the other window remembered `work`.
    localStorage.setItem('hermes.connections.lastProfileByConnection', JSON.stringify({ studio: 'work' }))

    await applySource({ connectionId: 'studio', dialSeq: 2, seq: 2 })

    expect(invoke).toHaveBeenCalledWith('connections_resolve', { connectionId: 'studio', profile: 'work' })
    expect(lastProfileFor('studio')).toBe('work')
  })

  it('drops a source no newer than the one it has applied: a replay, the older half of a crossed pair', async () => {
    await applySource({ connectionId: 'studio', dialSeq: 5, seq: 5 })

    await expect(applySource({ connectionId: 'lab', dialSeq: 5, seq: 5 })).resolves.toBe(false)
    await expect(applySource({ connectionId: 'lab', dialSeq: 4, seq: 4 })).resolves.toBe(false)

    expect($activeConnection.get()?.connectionId).toBe('studio')

    await applySource({ connectionId: 'lab', dialSeq: 6, seq: 6 })

    expect($activeConnection.get()?.connectionId).toBe('lab')
  })

  it('does nothing on the row it is already on — until that row has had to be re-dialled', async () => {
    await applySource({ connectionId: 'studio', dialSeq: 2, seq: 2 })
    order.length = 0

    // A peer re-applied the row, or clicked another of its profiles.
    await expect(applySource({ connectionId: 'studio', dialSeq: 2, seq: 3 })).resolves.toBe(false)
    expect(order).toEqual([])

    // Its dial fields were edited: every window on it re-dials.
    await expect(applySource({ connectionId: 'studio', dialSeq: 4, seq: 4 })).resolves.toBe(true)
    expect(order.filter(step => step !== 'remember')).toEqual(['publish:studio', 'dispose', 'emit', 'land'])
  })

  // S1: the newer source was recorded without superseding the older apply, which
  // then landed last and left this window on a source no other window was on.
  it('publishes nothing from an older apply that resolves after a newer one', async () => {
    const slow = gated({ ...RESOLVED, connectionId: 'studio' })

    await applySource({ connectionId: 'lab', dialSeq: 2, seq: 2 })
    invoke.mockImplementation(async (command: string, args: { connectionId?: string } = {}) =>
      args.connectionId === 'studio' ? slow.pending : { ...RESOLVED, connectionId: args.connectionId }
    )

    const older = applySource({ connectionId: 'studio', dialSeq: 3, seq: 3 })

    // Back to the row the window never left — the early return of the bug.
    await applySource({ connectionId: 'lab', dialSeq: 4, seq: 4 })
    slow.open()

    await expect(older).resolves.toBe(false)
    expect($activeConnection.get()?.connectionId).toBe('lab')
  })

  it('leaves the source it had when no row is left to be on', async () => {
    await expect(applySource({ connectionId: null, dialSeq: 2, seq: 2 })).resolves.toBe(true)

    expect($activeConnection.get()).toBeNull()
    expect(emitConnectionApplied).toHaveBeenCalledTimes(1)
  })

  it('stays where it is when the row cannot be resolved, or the payload is not a source', async () => {
    invoke.mockRejectedValue({ kind: 'not-found', message: 'no gateway with id "gone"' })

    await expect(applySource({ connectionId: 'gone', dialSeq: 2, seq: 2 })).resolves.toBe(false)
    await expect(applySource({ connectionId: 'studio' } as never)).resolves.toBe(false)

    expect($activeConnection.get()?.connectionId).toBe('old')
  })
})

// The watcher is the only cross-window signal for the source.
describe('startConnectionsWatcher', () => {
  it("applies Rust's announcement of a source, and refreshes the roster on every change", async () => {
    seedRegistry([LOCAL_CONNECTION_ID, 'studio'])
    onOld()

    const stop = startConnectionsWatcher()
    const heard = listen.mock.calls.at(-1)?.[1] as (event: { payload: unknown }) => void

    expect(listen.mock.calls.at(-1)?.[0]).toBe('hermes://connections-changed')

    heard({ payload: { connectionId: 'studio', reason: 'saved' } })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('connections_list', {}))
    expect($activeConnection.get()?.connectionId).toBe('old')

    heard({ payload: { connectionId: 'studio', dialSeq: 7, reason: 'source', seq: 7 } })
    await vi.waitFor(() => expect($activeConnection.get()?.connectionId).toBe('studio'))

    stop()
  })
})

// A connect form's Connect: desktop's applyConnectionConfig — save, then switch.
describe('applyConnection', () => {
  beforeEach(() => {
    seedRegistry(['studio'])
    invoke.mockImplementation(
      async (command: string, args: { connectionId?: string; input?: { id?: string } } = {}) => {
        if (command === 'connections_save') {
          return { connectionId: args.input?.id ?? 'minted', registry: $registryView.get() }
        }

        if (command === 'connections_resolve') {
          return { ...RESOLVED, connectionId: args.connectionId }
        }

        return rustSourceCommand(command, args.connectionId) ?? $registryView.get()
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

  // N6: every window of the origin writes the one key. A page that wrote the map
  // it LOADED with wrote away whatever a peer had remembered since.
  it("merges onto storage, so two windows do not write each other's entries away", () => {
    const key = 'hermes.connections.lastProfileByConnection'

    localStorage.setItem(key, JSON.stringify({ lab: 'play' }))

    __testing.rememberProfile('studio', 'work')

    expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toEqual({ lab: 'play', studio: 'work' })
    expect($lastProfileByConnection.get()).toEqual({ lab: 'play', studio: 'work' })
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
    $registryView.set({
      ...$registryView.get(),
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
      command === 'connections_save' ? { registry: $registryView.get() } : undefined
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
