import { beforeEach, describe, expect, it, vi } from 'vitest'

// SEVERAL WINDOWS, ONE RUST CORE (MJXHRM-602). Each fake window is its own
// evaluation of the real `store/connections` — its own atoms, its own
// `appliedSeq` — over one fake core (`test/source-core.ts`): one `seq` counter,
// one announcement fanned out to every window, deliveries and resolves held and
// released by the test so two windows can be interleaved on purpose.
//
// The model these check is `src-tauri/src/connections/source.rs`'s.

const ctx = vi.hoisted(() => ({
  answerListeners: new Set<(prompt: { attemptId: string; kind: string }, answer: string) => void>(),
  applied: [] as string[],
  authenticate: new Map<string, (args: { url: string }) => Promise<unknown>>(),
  cancelled: [] as string[],
  core: null as unknown,
  legacyTarget: null as null | { mode: string; url: string },
  pendingOAuth: null as null | { base: string; connectionId?: string; nonce?: string }
}))

// What no window holds state in. (A `vi.mock` factory runs ONCE, however often
// the modules are reset — so whatever is a window's own is mocked per window,
// in `mockWindow` below.)
vi.mock('@/hermes', () => ({  getApiRequestConnection: () => null,
  getApiRequestProfile: () => 'default',
 setApiRequestProfile: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  oauthStatus: vi.fn(async () => ({ signedIn: true })),
  oauthStatusIsUnknown: () => false,
  portalAgentSignIn: vi.fn()
}))
vi.mock('@/lib/platform', () => ({ IS_MOBILE: false, IS_TAURI: true }))
vi.mock('@/lib/secure-store', () => ({ mergeSshSecrets: vi.fn(async () => true) }))
vi.mock('@/store/gateway', () => ({ disposeSecondariesForConnection: vi.fn() }))
vi.mock('@/store/installation-id', () => ({ getInstallationId: vi.fn(async () => 'a'.repeat(32)) }))
vi.mock('@/store/notifications', () => ({ dismissNotification: vi.fn(), notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/ssh-backend', () => ({
  addSshPromptAnswerListener: (listener: (prompt: { attemptId: string; kind: string }, answer: string) => void) => {
    ctx.answerListeners.add(listener)

    return () => ctx.answerListeners.delete(listener)
  },
  attachSshPrompts: vi.fn(async () => () => {}),
  cancelSsh: async (attemptId: string) => void ctx.cancelled.push(attemptId),
  newAttemptId: () => 'attempt-1',
  onSshProgress: vi.fn(async () => () => {})
}))
vi.mock('@/store/windows', () => ({
  isActivityWindow: () => false,
  isHudWindow: () => false,
  isSatelliteWindow: () => false
}))

import { disposeSecondariesForConnection } from '@/store/gateway'
import { deferred } from '@/test/deferred'
import { createSourceCore, type SourceCore } from '@/test/source-core'

// Types only: each window evaluates the module for itself (`openWindow`).
import type * as ConnectionsModule from './connections'

function core(): SourceCore {
  return ctx.core as SourceCore
}

interface FakeWindow {
  connections: typeof ConnectionsModule
  id: string
  /** The source this window is on. */
  on(): null | string
  pending(): null | string
}

/** One window's own: its wire to Rust, its fold's re-dial signal, its atoms. */
function mockWindow(id: string): void {
  vi.doMock('@tauri-apps/api/core', () => ({
    invoke: (command: string, args?: Record<string, unknown>) => core().invoke(id, command, args)
  }))
  vi.doMock('@tauri-apps/api/event', () => ({
    listen: async (event: string, handler: (event: { payload: unknown }) => void) => core().listen(id, event, handler)
  }))
  vi.doMock('@/lib/hermes-desktop/connection-applied', () => ({
    emitConnectionApplied: () => void ctx.applied.push(id)
  }))
  vi.doMock('@/store/connection', () => ({
    authenticate: (args: { url: string }) =>
      ctx.authenticate.get(id)?.(args) ?? Promise.resolve({ authMode: 'none', baseUrl: args.url, mode: 'remote' }),
    keepSession: vi.fn(async () => {})
  }))
  vi.doMock('@/store/gateway-restore', async () => {
    const { atom } = await import('@/store/atom')

    return {
      $restoring: atom(true),
      // The real claim's contract: Rust decides which window has the marker.
      claimPendingOAuth: async () => {
        const pending = ctx.pendingOAuth

        return pending && (await core().invoke(id, 'connections_claim_resume', { marker: pending.nonce }))
          ? pending
          : null
      },
      loadGatewayTarget: () => ctx.legacyTarget
    }
  })
  vi.doMock('@/store/profile', async () => {
    const { atom } = await import('@/store/atom')

    return {
      $activeGatewayProfile: atom('default'),
      $newChatProfile: atom<null | string>(null),
      $showAllProfiles: atom(false),
      captureNewChatSource: vi.fn(),
      normalizeProfileKey: (name?: null | string) => (name ?? '').trim() || 'default',
      requestFreshSession: vi.fn()
    }
  })
  vi.doMock('@/store/session', async () => ({ $connection: (await import('@/store/atom')).atom<unknown>(null) }))
}

/** Boot a window: its own modules, listening, then the launch read. */
async function openWindow(id: string, owner = false): Promise<FakeWindow> {
  vi.resetModules()
  mockWindow(id)

  const connections = await import('./connections')
  const { $activeConnection } = await import('./active-connection')

  connections.startConnectionsWatcher()
  await connections.restoreLaunchConnection(owner)

  return {
    connections,
    id,
    on: () => $activeConnection.get()?.connectionId ?? null,
    pending: () => connections.$pendingConnectionId.get()
  }
}

/** Every announcement has been heard and every apply it started has settled. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    await Promise.resolve()
  }
}

const appliedIn = (window: string) => ctx.applied.filter(id => id === window).length

beforeEach(() => {
  localStorage.clear()
  ctx.answerListeners.clear()
  ctx.applied.length = 0
  ctx.authenticate.clear()
  ctx.cancelled.length = 0
  ctx.legacyTarget = null
  ctx.pendingOAuth = null
  ctx.core = createSourceCore({ lastUsed: 'home', rows: ['home', 'studio', 'lab'] })
})

describe('several windows over one Rust core', () => {
  it('evaluates each window apart: its own store, the one core', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')

    expect(main.connections).not.toBe(tile.connections)
    expect([main.on(), tile.on()]).toEqual(['home', 'home'])
    // Launch was decided once, by whoever read first; the tile only read it.
    expect(core().current()).toEqual({ connectionId: 'home', dialSeq: 1, seq: 1 })
    // A launch is an identity, not a switch: no fold was told to re-dial.
    expect(ctx.applied).toEqual([])
  })

  // B1 — "New window" loads a bare index.html, so it OWNS persisted app state.
  // It used to honour the launch mode, stamp the newest commit and drag every
  // window off the source the person chose.
  it('[B1] opens a new instance window onto the source the person chose, whatever the launch mode', async () => {
    ctx.core = createSourceCore({ lastUsed: 'home', launchMode: 'primary', primary: 'home', rows: ['home', 'studio'] })

    const main = await openWindow('main', true)

    await main.connections.selectConnection('studio')
    await settled()

    const commits = core().count('connections_commit_source')
    const applied = ctx.applied.length
    const instance = await openWindow('instance-1', true)

    await settled()

    expect(instance.on()).toBe('studio')
    expect(main.on()).toBe('studio')
    // It committed nothing, told nobody, and moved nobody.
    expect(core().count('connections_commit_source')).toBe(commits)
    expect(core().count('connections_set_last_used')).toBe(0)
    expect(core().current()).toEqual({ connectionId: 'studio', dialSeq: 2, seq: 2 })
    expect(core().lastUsed()).toBe('studio')
    expect(ctx.applied).toHaveLength(applied)
  })

  // S1 — the same-source early return recorded the newer commit without
  // superseding the older follow still awaiting `connections_resolve`.
  it('[S1] ends on the newer of two follows when the older one resolves last', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')
    const openStudio = core().holdResolve('tile-1', 'studio')

    await main.connections.selectConnection('studio')
    await settled()

    // The tile is still resolving `studio` when the app moves back to `home`,
    // which the tile never left.
    expect(tile.on()).toBe('home')

    await main.connections.selectConnection('home')
    await settled()
    openStudio()
    await settled()

    expect([main.on(), tile.on()]).toEqual(['home', 'home'])
    expect(core().current()?.connectionId).toBe('home')
    // What following both costs: the app LEFT `home` and came back, so `home`
    // was re-committed as a move (`dialSeq` 3) — and the tile, which never left
    // it, re-dials once all the same. Only the superseded follow is free.
    expect(core().current()).toEqual({ connectionId: 'home', dialSeq: 3, seq: 3 })
    expect([appliedIn('main'), appliedIn('tile-1')]).toEqual([2, 1])
  })

  it('[3] leaves a window whose preflight failed on the source a peer committed meanwhile', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')
    const preflight = deferred<unknown>()

    ctx.authenticate.set('tile-1', () => preflight.promise)

    const failing = tile.connections.selectConnection('lab')

    await settled()
    expect(tile.pending()).toBe('lab')

    await main.connections.selectConnection('studio')
    await settled()

    // The peer's commit superseded the preflight: applied, spinner down.
    expect(tile.on()).toBe('studio')
    expect(tile.pending()).toBeNull()

    preflight.reject(new Error('Backend responded HTTP 502'))

    // …and a superseded switch's failure is nobody's.
    await expect(failing).resolves.toBeUndefined()
    expect([main.on(), tile.on()]).toEqual(['studio', 'studio'])
    expect(core().count('connections_commit_source', 'tile-1')).toBe(0)
  })

  // The same class, the other way round: the click must not cancel a commit
  // the app has already made and this window is still resolving.
  it('[3b] still lands a follow that was resolving when a click started, and then failed', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')
    const openStudio = core().holdResolve('tile-1', 'studio')

    await main.connections.selectConnection('studio')
    await settled()
    ctx.authenticate.set('tile-1', () => Promise.reject(new Error('Backend responded HTTP 502')))

    await expect(tile.connections.selectConnection('lab')).rejects.toThrow('Backend responded HTTP 502')
    expect(tile.on()).toBe('home')

    openStudio()
    await settled()

    expect([main.on(), tile.on()]).toEqual(['studio', 'studio'])
  })

  it('[4] puts every window on the higher seq when two commit at once', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')
    const hud = await openWindow('sat-hud')

    // Neither hears the other until both have committed: a crossed pair.
    core().hold('main')
    core().hold('tile-1')

    await Promise.all([main.connections.selectConnection('studio'), tile.connections.selectConnection('lab')])

    expect([main.on(), tile.on()]).toEqual(['studio', 'lab'])

    // The later committer hears the older commit, with time to act on it…
    core().deliver('tile-1', 1)
    await settled()
    expect(tile.on()).toBe('lab')

    core().deliver('main')
    core().deliver('tile-1')
    await settled()

    expect(core().current()).toEqual({ connectionId: 'lab', dialSeq: 3, seq: 3 })
    expect([main.on(), tile.on(), hud.on()]).toEqual(['lab', 'lab', 'lab'])
    // Nobody went back: the window that committed LAST heard the older commit
    // after its own and dropped it, rather than re-homing twice to get here —
    // and the bystander, told both at once, re-homed for the newer one only.
    expect([appliedIn('main'), appliedIn('tile-1'), appliedIn('sat-hud')]).toEqual([2, 1, 1])
  })

  it('[5] applies its own commit from the return value, and the announcement of it is a no-op', async () => {
    const main = await openWindow('main', true)

    core().hold('main')
    await main.connections.selectConnection('studio')

    // On the target before it has heard anything.
    expect(main.on()).toBe('studio')
    expect(appliedIn('main')).toBe(1)

    core().deliver('main')
    await settled()

    expect(main.on()).toBe('studio')
    expect(appliedIn('main')).toBe(1)
    // …and it resolved the row once: the announcement did not re-home it.
    expect(core().count('connections_resolve', 'main')).toBe(2)
  })

  // Rust's announcement and the command's return value race to the window that
  // committed. The fake core announces first, every time.
  it('[5b] applies its own commit once when the announcement beats the return value', async () => {
    const main = await openWindow('main', true)

    ctx.authenticate.set('main', async ({ url }) => ({ authMode: 'ticket', baseUrl: url, mode: 'remote' }))
    await main.connections.selectConnection('studio')
    await settled()

    const { $activeConnection } = await import('./active-connection')

    expect(appliedIn('main')).toBe(1)
    // With what the preflight proved — which only the return value's apply has.
    expect($activeConnection.get()?.connection.authMode).toBe('ticket')
    expect(core().count('connections_resolve', 'main')).toBe(2)
  })

  it('[6] moves every window to the primary when the row the app is on is removed', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')

    await main.connections.selectConnection('studio')
    await settled()
    expect([main.on(), tile.on()]).toEqual(['studio', 'studio'])

    await tile.connections.removeConnection('studio')
    await settled()

    expect(core().current()).toEqual({ connectionId: 'home', dialSeq: 3, seq: 3 })
    expect([main.on(), tile.on()]).toEqual(['home', 'home'])

    // Another row going is nobody's business.
    const applied = ctx.applied.length

    await main.connections.removeConnection('lab')
    await settled()

    expect(core().current()?.seq).toBe(3)
    expect(ctx.applied).toHaveLength(applied)
  })

  it('re-dials every window on a row whose dial fields were edited, and only those', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')

    core().editRow('lab')
    await settled()
    expect(ctx.applied).toEqual([])

    core().editRow('home')
    await settled()

    expect(core().current()).toEqual({ connectionId: 'home', dialSeq: 2, seq: 2 })
    expect([appliedIn('main'), appliedIn('tile-1')]).toEqual([1, 1])
    expect([main.on(), tile.on()]).toEqual(['home', 'home'])
  })

  // The save → re-commit path, as the editor drives it: Rust announces the
  // re-commit BEFORE `connections_save` returns, and returns it as `source`.
  it('re-dials the window that saved from the return value, and each peer on the row once', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')

    const saved = await main.connections.saveConnection({
      id: 'home',
      kind: 'remote',
      label: 'home',
      url: 'https://home-moved.test'
    })

    await settled()

    expect(saved).toMatchObject({ dialFieldsChanged: true, source: { connectionId: 'home', dialSeq: 2, seq: 2 } })
    expect([appliedIn('main'), appliedIn('tile-1')]).toEqual([1, 1])

    const { $activeConnection } = await import('./active-connection')

    // (The last window opened is the one whose modules this test file sees.)
    expect($activeConnection.get()?.connection.baseUrl).toBe('https://home-moved.test')

    // A rename is no dial field, and a row nobody is on is nobody's re-dial.
    await main.connections.saveConnection({ id: 'home', kind: 'remote', label: 'Home' })
    await main.connections.saveConnection({ id: 'lab', kind: 'remote', label: 'lab', url: 'https://lab-moved.test' })
    await settled()

    expect(core().current()?.seq).toBe(2)
    expect([appliedIn('main'), appliedIn('tile-1')]).toEqual([1, 1])
  })

  // A connect form's Connect onto the row the app is on (`applyConnection`):
  // the save re-commits it, the select that follows commits it again — and a
  // peer still re-dials ONCE, for the save; the select's commit moves nothing.
  it('re-dials a peer once when a connect form re-applies the row the app is on with a new dial field', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')

    await main.connections.applyConnection({ authMode: 'token', kind: 'remote', token: 't', url: 'https://home.test' })
    await settled()

    expect(core().row('home')?.authMode).toBe('token')
    expect(core().current()).toEqual({ connectionId: 'home', dialSeq: 2, seq: 3 })
    expect(appliedIn('tile-1')).toBe(1)
    expect([main.on(), tile.on()]).toEqual(['home', 'home'])
  })

  // A row seeded from the pre-registry target says `none` whatever its gateway
  // is. The click that proves otherwise writes it back BEFORE it commits, so
  // the peers it moves resolve a row that names the gate.
  it('re-stamps a row its preflight proved gated before committing it, so a peer mints for the gate', async () => {
    const main = await openWindow('main', true)

    await openWindow('tile-1')

    ctx.authenticate.set('main', async ({ url }) => ({
      authMode: url === 'https://studio.test' ? 'oauth' : 'none',
      baseUrl: url,
      mode: 'remote'
    }))
    await main.connections.selectConnection('studio')
    await settled()

    const order = core()
      .calls.filter(call => call.command === 'connections_save' || call.command === 'connections_commit_source')
      .map(call => call.command)

    expect(order).toEqual(['connections_save', 'connections_commit_source'])
    expect(core().saves).toEqual([
      { authMode: 'oauth', id: 'studio', kind: 'remote', label: 'studio', url: 'https://studio.test' }
    ])

    const { $activeConnection } = await import('./active-connection')

    // The tile's identity, which it built from the row alone.
    expect($activeConnection.get()).toMatchObject({ connection: { authMode: 'oauth' }, connectionId: 'studio' })
    expect([appliedIn('main'), appliedIn('tile-1')]).toEqual([1, 1])

    // A row that already agrees is left alone: no save, so no re-dial to loop on.
    await main.connections.selectConnection('home')
    await main.connections.selectConnection('studio')
    await settled()

    expect(core().count('connections_save')).toBe(1)
  })

  // The same correction on the row the app is ON (a connect form's Connect):
  // the save re-commits it, and Rust announces that before the save returns.
  // The window that is about to commit must not apply it as a peer's — it would
  // re-dial twice, the first time without what its preflight proved.
  it('re-dials the window that corrected the row it is on once, from its own commit', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')

    ctx.authenticate.set('main', async ({ url }) => ({ authMode: 'ticket', baseUrl: url, mode: 'remote' }))
    await main.connections.applyConnection({ kind: 'remote', url: 'https://home.test' })
    await settled()

    expect(core().row('home')?.authMode).toBe('oauth')
    expect(core().current()).toEqual({ connectionId: 'home', dialSeq: 2, seq: 3 })
    expect([appliedIn('main'), appliedIn('tile-1')]).toEqual([1, 1])
    expect([main.on(), tile.on()]).toEqual(['home', 'home'])
  })

  // The upgraded user who never clicks: the bridge's dial-time probe finds the
  // gate (`discoverGate`) and writes it back. `authMode` is a dial field, so
  // every window on the row re-dials — once: the row agrees from then on.
  it('re-dials every window on a row whose gate a dial discovered, once, and does not loop', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')

    expect(await tile.connections.correctAuthMode('home', 'oauth')).toBe(true)
    await settled()

    expect(core().row('home')?.authMode).toBe('oauth')
    expect(core().current()).toEqual({ connectionId: 'home', dialSeq: 2, seq: 2 })
    expect([appliedIn('main'), appliedIn('tile-1')]).toEqual([1, 1])

    // The re-dial it caused probes nothing; a window that had probed for itself
    // finds the row already says so.
    expect(await main.connections.correctAuthMode('home', 'oauth')).toBe(false)
    expect(await tile.connections.correctAuthMode('home', 'oauth')).toBe(false)
    await settled()

    expect(core().count('connections_save')).toBe(1)
    expect([appliedIn('main'), appliedIn('tile-1')]).toEqual([1, 1])
  })

  // The launch read returned seq N; N+1 was announced while the launch apply
  // was resolving its row. The launch settled on the null before N+1 landed,
  // and the released bridge answered the hook's first dial with no connection.
  it('holds the launch until the source that overtook it has been applied', async () => {
    const main = await openWindow('main', true)
    const openHome = core().holdResolve('tile-1', 'home')
    const openStudio = core().holdResolve('tile-1', 'studio')
    let launched = false

    const opening = openWindow('tile-1').then(tile => {
      launched = true

      return tile
    })

    await vi.waitFor(() => expect(core().count('connections_resolve', 'tile-1')).toBe(1))
    await main.connections.selectConnection('studio')
    await vi.waitFor(() => expect(core().count('connections_resolve', 'tile-1')).toBe(2))

    // The launch apply loses to the newer source…
    openHome()
    await settled()
    // …and the launch is still held, because that source is still resolving.
    expect(launched).toBe(false)

    openStudio()

    expect((await opening).on()).toBe('studio')
  })

  // A peer re-committing the row this window is ON moves nothing here, so it
  // must not cancel the switch a person has in flight.
  it('lets a click in flight land when a peer re-commits the row the window is on', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')
    const preflight = deferred<unknown>()

    ctx.authenticate.set('tile-1', () => preflight.promise)

    const switching = tile.connections.selectConnection('lab')

    await settled()
    await main.connections.selectConnection('home')
    await settled()

    expect(tile.pending()).toBe('lab')

    preflight.resolve({ authMode: 'none', baseUrl: 'https://lab.test', mode: 'remote' })
    await switching
    await settled()

    expect([main.on(), tile.on()]).toEqual(['lab', 'lab'])
  })

  // …and one that IS superseded takes its question down with it: the prompt
  // used to stay up until Rust's timeout, taking an answer that went nowhere.
  it('cancels the SSH attempt of a preflight a newer source superseded', async () => {
    ctx.core = createSourceCore({ rows: ['home', 'studio', { id: 'box', kind: 'ssh' }] })

    const asked = deferred()
    const dial = deferred<unknown>()
    const invoke = core().invoke

    core().invoke = async (window, command, args) => {
      if (command === 'tunnel_page_open') {
        return 1
      }

      if (command === 'tunnel_acquire') {
        asked.resolve()

        return dial.promise
      }

      return invoke(window, command, args)
    }

    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')
    const switching = tile.connections.selectConnection('box')

    await asked.promise
    expect(ctx.cancelled).toEqual([])

    await main.connections.selectConnection('studio')
    await settled()

    expect(ctx.cancelled).toEqual(['attempt-1'])

    // Rust ends the cancelled attempt; the superseded switch says nothing.
    dial.reject({ kind: 'cancelled', message: 'cancelled' })

    await expect(switching).resolves.toBeUndefined()
    expect([tile.on(), tile.pending()]).toEqual(['studio', null])
    expect(ctx.answerListeners.size).toBe(0)
  })

  // The apply of a switch's own commit supersedes everything in flight — the
  // switch that made it included, whose own failure then read as nobody's.
  it('reports a failure of its own apply, which used to read as a superseded switch', async () => {
    const main = await openWindow('main', true)

    vi.mocked(disposeSecondariesForConnection).mockImplementationOnce(() => {
      throw new Error('registry torn')
    })

    await expect(main.connections.selectConnection('studio')).rejects.toThrow()
    expect(main.pending()).toBeNull()
  })

  // The owner window seeds the registry AFTER another window has already asked
  // where the app is: launch is asked again, of the real rows.
  it('moves a window that launched before the seed onto the row the seed names', async () => {
    ctx.core = createSourceCore({ rows: ['studio'], unseeded: true })

    const early = await openWindow('tile-1')

    expect(early.on()).toBeNull()

    ctx.legacyTarget = { mode: 'remote', url: 'https://studio.test' }

    const owner = await openWindow('main', true)

    await settled()

    expect(core().current()).toEqual({ connectionId: 'studio', dialSeq: 2, seq: 2 })
    expect([early.on(), owner.on()]).toEqual(['studio', 'studio'])
    // A second owner (another instance window) re-seeds nothing.
    await openWindow('instance-1', true)
    expect(core().current()?.seq).toBe(2)
  })

  it('costs a peer nothing when a window re-commits the row the app is already on', async () => {
    const main = await openWindow('main', true)
    const tile = await openWindow('tile-1')

    // The fleet rail's other profile of the same source, and a plain re-click.
    await main.connections.selectConnection('home', { profile: 'work' })
    await main.connections.selectConnection('home')
    await settled()

    expect(core().current()).toEqual({ connectionId: 'home', dialSeq: 1, seq: 3 })
    expect(appliedIn('main')).toBe(1)
    expect(appliedIn('tile-1')).toBe(0)
    expect(tile.on()).toBe('home')
  })

  it('resumes an interrupted sign-in in ONE window when several boot with the marker', async () => {
    ctx.pendingOAuth = { base: 'https://studio.test', connectionId: 'studio', nonce: 'n-1' }

    const [main, activity] = [await openWindow('main', true), await openWindow('screen')]

    await settled()

    expect(core().count('connections_commit_source')).toBe(1)
    expect([main.on(), activity.on()]).toEqual(['studio', 'studio'])
  })

  // S2 — a switcher click prompts for the passphrase; nothing kept it, and after
  // Rust's linger the first background redial was refused as needing a person.
  it('[S2] keeps the SSH answer a bare-call select was given', async () => {
    ctx.core = createSourceCore({ rows: ['home', { id: 'box', kind: 'ssh' }] })

    const asked = deferred()
    const answered = deferred()
    const invoke = core().invoke

    core().invoke = async (window, command, args) => {
      if (command === 'tunnel_page_open') {
        return 1
      }

      if (command === 'tunnel_acquire') {
        asked.resolve()
        await answered.promise

        return { baseUrl: 'http://127.0.0.1:41000', connectionId: 'box', generation: 1, instanceKey: 'ssh:me@box:22' }
      }

      return invoke(window, command, args)
    }

    const main = await openWindow('main', true)
    const switching = main.connections.selectConnection('box')

    await asked.promise

    // Rust asks mid-dial; the person answers the window's prompt dialog.
    for (const listener of ctx.answerListeners) {
      listener({ attemptId: 'attempt-1', kind: 'passphrase' }, 'hunter2')
      listener({ attemptId: 'attempt-1', kind: 'keyboard-interactive' }, '123456')
      listener({ attemptId: 'someone-elses', kind: 'passphrase' }, 'not-mine')
    }

    answered.resolve()
    await switching

    expect(main.on()).toBe('box')
    // Kept where a tunnel's own Connect keeps it (`saveTunnelAnswer`): on the
    // row's own accounts, through its save — the passphrase, and only that.
    expect(core().saves).toEqual([{ id: 'box', kind: 'ssh', label: 'box', passphrase: 'hunter2' }])
    // The keeper lives as long as the dial it listens to.
    expect(ctx.answerListeners.size).toBe(0)
  })
})
