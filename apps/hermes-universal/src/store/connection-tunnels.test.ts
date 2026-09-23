import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { answerListeners, attachSshPrompts, handlers, httpRequest, invoke, platform, windowKind } = vi.hoisted(() => ({
  answerListeners: new Set<(prompt: { attemptId: string; kind: string }, answer: string) => void>(),
  attachSshPrompts: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  httpRequest: vi.fn(),
  invoke: vi.fn(),
  platform: { mobile: false, tauri: true },
  windowKind: { activity: false, satellite: null as null | string }
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler)

    return () => handlers.delete(name)
  })
}))
vi.mock('@/lib/platform', () => ({
  get IS_MOBILE() {
    return platform.mobile
  },
  get IS_TAURI() {
    return platform.tauri
  }
}))
vi.mock('@/store/installation-id', () => ({ getInstallationId: vi.fn(async () => 'a'.repeat(32)) }))
vi.mock('@/store/ssh-backend', () => ({
  addSshPromptAnswerListener: (listener: (prompt: { attemptId: string; kind: string }, answer: string) => void) => {
    answerListeners.add(listener)

    return () => answerListeners.delete(listener)
  },
  attachSshPrompts,
  newAttemptId: () => 'attempt-7',
  onSshProgress: vi.fn(async () => () => {})
}))
vi.mock('@/store/windows', () => ({
  isActivityWindow: () => windowKind.activity,
  isHudWindow: () => windowKind.satellite === 'hud',
  isSatelliteWindow: () => windowKind.satellite !== null
}))
vi.mock('@/transport/http', () => ({ httpRequest }))

import { TRANSLATIONS } from '@/i18n/catalog'
import { api, setConnectionBaseResolver } from '@/lib/api'
import { $notifications } from '@/store/notifications'

import {
  $tunnelStatus,
  __testing,
  acquireTunnel,
  connectionBase,
  connectTunnel,
  isTunnelSignInError,
  keepTunnelAnswers,
  needsInteraction,
  openTunnelPage,
  setTunnelAnswerSaver,
  type TunnelStatus
} from './connection-tunnels'

const descriptor = {
  baseUrl: 'http://127.0.0.1:41000',
  connectionId: 'ssh1',
  generation: 1,
  instanceKey: 'ssh:deploy@box:22'
}

const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command)

/** Stub every command but `tunnel_page_open`, which opens at epoch 3. */
const withPageOpen = (implementation: (command: string, args: never) => unknown) =>
  invoke.mockImplementation((command: string, args: never) =>
    command === 'tunnel_page_open' ? Promise.resolve(3) : implementation(command, args)
  )

beforeEach(() => {
  __testing.reset()
  handlers.clear()
  invoke.mockReset()
  attachSshPrompts.mockReset()
  httpRequest.mockReset()
  platform.mobile = false
  platform.tauri = true
  windowKind.activity = false
  windowKind.satellite = null
  $notifications.set([])
  answerListeners.clear()
  invoke.mockImplementation(async (command: string) =>
    command === 'tunnel_acquire' ? descriptor : command === 'tunnel_page_open' ? 3 : undefined
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('acquireTunnel', () => {
  it('J1: holds one lease per connection per window, however many callers', async () => {
    const [first, second] = await Promise.all([acquireTunnel('ssh1'), acquireTunnel('ssh1')])

    expect(calls('tunnel_acquire')).toHaveLength(1)
    expect(first.instanceKey).toBe('ssh:deploy@box:22')

    first.release()
    first.release()
    expect(calls('tunnel_release')).toHaveLength(0)

    second.release()
    expect(calls('tunnel_release')).toHaveLength(1)
    expect(calls('tunnel_release')[0]?.[1]).toEqual({
      connectionId: 'ssh1',
      leaseId: (calls('tunnel_acquire')[0]?.[1] as { leaseId: string }).leaseId
    })
  })

  it('J2: a redial moves the base, and a cross-connection call follows it', async () => {
    setConnectionBaseResolver(connectionId => connectionBase(null, connectionId))
    httpRequest.mockResolvedValue({ body: '{}', status: 200 })

    const lease = await acquireTunnel('ssh1')
    const seen: number[] = []

    lease.onChange(next => seen.push(next.generation))
    handlers.get('tunnel://ssh1/changed')?.({
      payload: { ...descriptor, baseUrl: 'http://127.0.0.1:42000', generation: 2 }
    })

    expect(lease.baseUrl()).toBe('http://127.0.0.1:42000')
    expect(lease.wsUrl()).toBe('ws://127.0.0.1:42000/api/ws')
    expect(lease.generation()).toBe(2)
    expect(lease.instanceKey).toBe('ssh:deploy@box:22')
    expect(seen).toEqual([2])

    await api({ connectionId: 'ssh1', path: '/api/status' })

    expect(httpRequest.mock.calls[0]?.[1]).toBe('http://127.0.0.1:42000/api/status')
  })

  it('J5: only a terminal failure needs a person', () => {
    const status = (patch: Partial<TunnelStatus>): TunnelStatus => ({
      connectionId: 'ssh1',
      generation: 1,
      phase: 'failed',
      terminal: true,
      ...patch
    })

    expect(needsInteraction(status({ errorKind: 'locked' }))).toBe(true)
    expect(needsInteraction(status({ errorKind: 'transient', terminal: false }))).toBe(false)
    expect(needsInteraction(status({ phase: 'retrying', terminal: false }))).toBe(false)
    expect(needsInteraction(null)).toBe(false)
  })

  it('J5: the status event lands in $tunnelStatus', async () => {
    await acquireTunnel('ssh1')

    handlers.get('tunnel://ssh1/status')?.({
      payload: { connectionId: 'ssh1', errorKind: 'locked', generation: 1, phase: 'failed', terminal: true }
    })

    expect(needsInteraction($tunnelStatus.get().ssh1)).toBe(true)
  })

  // MJXHRM-592: Rust refuses a hold from a page that has reloaded or closed.
  it('opens the page once and sends its epoch with every acquire', async () => {
    await acquireTunnel('ssh1')
    await acquireTunnel('ssh2')

    expect(calls('tunnel_page_open')).toHaveLength(1)
    expect(calls('tunnel_acquire').map(([, args]) => (args as { pageEpoch: number }).pageEpoch)).toEqual([3, 3])
  })

  it('never keeps a failed page open: the next acquire opens again', async () => {
    let opens = 0

    invoke.mockImplementation(async (command: string) => {
      if (command === 'tunnel_page_open') {
        opens += 1

        if (opens === 1) {
          throw { kind: 'unavailable', message: 'refused', terminal: true }
        }

        return 9
      }

      return command === 'tunnel_acquire' ? descriptor : undefined
    })

    await expect(acquireTunnel('ssh1')).rejects.toMatchObject({ kind: 'unavailable' })
    expect(calls('tunnel_acquire')).toHaveLength(0)

    await acquireTunnel('ssh1')

    expect(calls('tunnel_page_open')).toHaveLength(2)
    expect(calls('tunnel_acquire')[0]?.[1]).toMatchObject({ pageEpoch: 9 })
  })

  it('never acquires with a page open that returned no epoch', async () => {
    let opens = 0

    invoke.mockImplementation(async (command: string) => {
      if (command === 'tunnel_page_open') {
        opens += 1

        return opens === 1 ? null : 5
      }

      return command === 'tunnel_acquire' ? descriptor : undefined
    })

    await expect(acquireTunnel('ssh1')).rejects.toMatchObject({ kind: 'unavailable' })
    expect(calls('tunnel_acquire')).toHaveLength(0)

    await acquireTunnel('ssh1')

    expect(calls('tunnel_acquire')[0]?.[1]).toMatchObject({ pageEpoch: 5 })
  })

  it('never acquires before the page has opened', async () => {
    let open = (_epoch: number) => {}

    invoke.mockImplementation((command: string) =>
      command === 'tunnel_page_open'
        ? new Promise<number>(resolve => (open = resolve))
        : Promise.resolve(command === 'tunnel_acquire' ? descriptor : undefined)
    )

    const acquiring = acquireTunnel('ssh1')

    await vi.waitFor(() => expect(calls('tunnel_page_open')).toHaveLength(1))
    // Every other await in the acquire has had its turn.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls('tunnel_acquire')).toHaveLength(0)

    open(4)
    await acquiring

    expect(calls('tunnel_acquire')[0]?.[1]).toMatchObject({ pageEpoch: 4 })
  })

  // MJXHRM-592: a reloaded page that never acquires still ends the old page's holds.
  it('opens the page at window boot, without an acquire, and acquires under that epoch', async () => {
    openTunnelPage()

    expect(calls('tunnel_page_open')).toHaveLength(1)
    expect(calls('tunnel_acquire')).toHaveLength(0)

    await acquireTunnel('ssh1')

    expect(calls('tunnel_page_open')).toHaveLength(1)
    expect(calls('tunnel_acquire')[0]?.[1]).toMatchObject({ pageEpoch: 3 })
  })

  it('never opens a page in a window that holds no tunnels', () => {
    windowKind.satellite = 'quick'
    openTunnelPage()
    windowKind.satellite = 'wake'
    openTunnelPage()
    windowKind.satellite = null
    platform.tauri = false
    openTunnelPage()

    expect(invoke).not.toHaveBeenCalled()
  })

  // Every dial is a lease, the primary's included: a window with a gateway of
  // its own has to be able to hold one. Rust reaps by window label either way.
  it.each([
    ['the HUD', { activity: false, satellite: 'hud' }, true],
    ['a mobile activity screen', { activity: true, satellite: null }, true],
    ['Quick Entry', { activity: false, satellite: 'quick' }, false],
    ['the wake indicator', { activity: false, satellite: 'wake' }, false]
  ] as const)('%s holds tunnels: %j → %s', async (_name, kind, holds) => {
    Object.assign(windowKind, kind)
    openTunnelPage()

    if (holds) {
      await expect(acquireTunnel('ssh1')).resolves.toMatchObject({ connectionId: 'ssh1' })
      expect(calls('tunnel_page_open')).toHaveLength(1)
    } else {
      await expect(acquireTunnel('ssh1')).rejects.toMatchObject({ kind: 'unavailable' })
      expect(invoke).not.toHaveBeenCalled()
    }
  })

  it('forgets the page open on a test reset', async () => {
    await acquireTunnel('ssh1')
    __testing.reset()
    await acquireTunnel('ssh1')

    expect(calls('tunnel_page_open')).toHaveLength(2)
  })

  it('J6: an interactive acquire attaches the prompts before it dials', async () => {
    const detach = vi.fn()

    attachSshPrompts.mockResolvedValue(detach)

    await acquireTunnel('ssh1', { interactive: true })

    // Its own attempt, so the prompts reach this dial and no other.
    expect(attachSshPrompts).toHaveBeenCalledWith('attempt-7')
    expect(attachSshPrompts.mock.invocationCallOrder[0]).toBeLessThan(
      invoke.mock.invocationCallOrder[invoke.mock.calls.findIndex(([name]) => name === 'tunnel_acquire')]
    )
    expect(calls('tunnel_acquire')[0]?.[1]).toMatchObject({ attemptId: 'attempt-7', interactive: true })
    expect(detach).toHaveBeenCalled()
  })

  it('J7: a phone has no local backend, but does have SSH', async () => {
    platform.mobile = true

    await expect(acquireTunnel('local')).rejects.toMatchObject({ kind: 'unsupported-platform' })
    expect(calls('tunnel_acquire')).toHaveLength(0)

    await expect(acquireTunnel('ssh1')).resolves.toMatchObject({ connectionId: 'ssh1' })
  })

  it('dials again once Rust has closed the slot under a held lease', async () => {
    const lease = await acquireTunnel('ssh1')

    handlers.get('tunnel://ssh1/status')?.({
      payload: { connectionId: 'ssh1', generation: 1, phase: 'closed', terminal: false }
    })

    const again = await acquireTunnel('ssh1')

    expect(calls('tunnel_acquire')).toHaveLength(2)

    lease.release()
    again.release()
    expect(calls('tunnel_release')).toHaveLength(1)
  })

  // MJXHRM-592: a hold never ages out. A hidden, occluded or paused webview's
  // timers stop without bound, so nothing about a held lease is timer-driven.
  it('keeps a held lease for an hour without a single timer', async () => {
    vi.useFakeTimers()

    const lease = await acquireTunnel('ssh1')
    const closed = vi.fn()

    lease.onClosed(closed)
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(invoke.mock.calls.map(([name]) => name)).toEqual(['tunnel_page_open', 'tunnel_acquire'])
    expect(closed).not.toHaveBeenCalled()
  })

  it('tells its consumers when the tunnel closed or needs sign-in', async () => {
    const lease = await acquireTunnel('ssh1')
    const closed = vi.fn()

    lease.onClosed(closed)
    handlers.get('tunnel://ssh1/status')?.({
      payload: { connectionId: 'ssh1', generation: 1, phase: 'retrying', terminal: false }
    })
    expect(closed).not.toHaveBeenCalled()

    handlers.get('tunnel://ssh1/status')?.({
      payload: { connectionId: 'ssh1', generation: 1, phase: 'closed', terminal: false }
    })
    handlers.get('tunnel://ssh1/status')?.({
      payload: { connectionId: 'ssh1', errorKind: 'locked', generation: 1, phase: 'failed', terminal: true }
    })

    expect(closed).toHaveBeenCalledTimes(2)
  })

  it('says Needs sign-in once per connection, with a Connect that only connects', async () => {
    withPageOpen(async (command: string, args: { interactive?: boolean }) => {
      if (command !== 'tunnel_acquire') {
        return undefined
      }

      if (args.interactive) {
        return descriptor
      }

      throw { kind: 'credentials-needed', message: 'needs a passphrase', terminal: true }
    })

    await expect(acquireTunnel('ssh1', { label: 'Box' })).rejects.toMatchObject({ kind: 'credentials-needed' })
    await expect(acquireTunnel('ssh1', { label: 'Box' })).rejects.toMatchObject({ kind: 'credentials-needed' })

    const shown = $notifications.get()

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ id: 'tunnel-signin:ssh1', title: 'Box needs sign-in' })

    invoke.mockClear()
    shown[0]?.action?.onClick()

    await vi.waitFor(() => expect(calls('tunnel_release')).toHaveLength(1))
    expect(calls('tunnel_acquire')).toHaveLength(1)
    expect(calls('tunnel_acquire')[0]?.[1]).toMatchObject({ interactive: true })
    // Signed in: the warning goes.
    expect($notifications.get()).toHaveLength(0)
  })

  // A changed host key is refused under every policy: there is nothing to Connect.
  it('warns about a changed host key once, with a Retry and no Connect', async () => {
    withPageOpen(async (command: string) => {
      if (command === 'tunnel_acquire') {
        throw { kind: 'host-key-changed', message: 'remove the old key with ssh-keygen -R box', terminal: true }
      }
    })

    await expect(acquireTunnel('ssh1', { label: 'Box' })).rejects.toMatchObject({ kind: 'host-key-changed' })
    await expect(acquireTunnel('ssh1', { label: 'Box' })).rejects.toMatchObject({ kind: 'host-key-changed' })

    const shown = $notifications.get()

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      detail: 'remove the old key with ssh-keygen -R box',
      id: 'tunnel-hostkey:ssh1',
      kind: 'error',
      title: 'Box'
    })
    expect(shown[0]?.action?.label).toBe(TRANSLATIONS.en.common.retry)
    // Not a sign-in either, so the session router never reports it as one.
    expect(isTunnelSignInError({ kind: 'host-key-changed', message: '', terminal: true })).toBe(false)
  })

  // Rust dials a connection that needs a person in the background no more, so
  // once `known_hosts` is fixed out of band only an interactive dial gets through.
  it("retries a changed host key through the person's own dial, once, and clears the warning", async () => {
    let fixed = false

    withPageOpen(async (command: string) => {
      if (command === 'tunnel_acquire') {
        if (!fixed) {
          throw { kind: 'host-key-changed', message: 'ssh-keygen -R box', terminal: true }
        }

        return descriptor
      }
    })

    await expect(acquireTunnel('ssh1', { label: 'Box' })).rejects.toMatchObject({ kind: 'host-key-changed' })

    fixed = true
    $notifications.get()[0]?.action?.onClick()

    await vi.waitFor(() => expect($notifications.get()).toHaveLength(0))

    expect(calls('tunnel_acquire')).toHaveLength(2)
    expect(calls('tunnel_acquire')[1]?.[1]).toMatchObject({ attemptId: 'attempt-7', interactive: true })
    // Connect only: its lease is let go like the failed hold before it, and
    // whatever failed is not replayed.
    expect(calls('tunnel_release')).toHaveLength(2)
  })

  it('raises nothing for a failure that retrying can fix', async () => {
    withPageOpen(async (command: string) => {
      if (command === 'tunnel_acquire') {
        throw { kind: 'transient', message: 'unreachable', terminal: false }
      }
    })

    await expect(acquireTunnel('ssh1', { label: 'Box' })).rejects.toMatchObject({ kind: 'transient' })
    expect($notifications.get()).toHaveLength(0)
  })

  describe('a Connect that fails', () => {
    const failWith = (error: object) =>
      withPageOpen(async (command: string) => {
        if (command === 'tunnel_acquire') {
          throw error
        }
      })

    it('stays quiet when the person dismissed the question', async () => {
      failWith({ kind: 'cancelled', message: 'cancelled', terminal: true })

      await connectTunnel('ssh1', 'Box')

      expect($notifications.get()).toHaveLength(0)
    })

    it('asks for sign-in again, saying why', async () => {
      failWith({ kind: 'credentials-needed', message: 'wrong passphrase', terminal: true })

      await connectTunnel('ssh1', 'Box')

      expect($notifications.get()).toEqual([
        expect.objectContaining({ detail: TRANSLATIONS.en.settings.gateway.sshErrAuth, id: 'tunnel-signin:ssh1' })
      ])
    })

    it('raises the host-key warning for a changed key', async () => {
      failWith({ kind: 'host-key-changed', message: 'ssh-keygen -R box', terminal: true })

      await connectTunnel('ssh1', 'Box')

      expect($notifications.get()).toEqual([expect.objectContaining({ id: 'tunnel-hostkey:ssh1' })])
    })

    // MJXHRM-592: the configurator's localized words, never Rust's English.
    it("reports an SSH failure in the configurator's words", async () => {
      failWith({ kind: 'transient', message: 'Timed out after 30s', sshKind: 'timeout', terminal: false })

      await connectTunnel('ssh1', 'Box')

      expect($notifications.get()).toEqual([
        expect.objectContaining({ kind: 'error', message: TRANSLATIONS.en.settings.gateway.sshErrTimeout })
      ])
    })

    it('says a locked device needs unlocking', async () => {
      failWith({ kind: 'locked', message: 'unlock this device to use the stored credentials', terminal: true })

      await connectTunnel('ssh1', 'Box')

      expect($notifications.get()).toEqual([
        expect.objectContaining({ detail: TRANSLATIONS.en.settings.gateway.sshErrLocked, id: 'tunnel-signin:ssh1' })
      ])
    })

    it('reports anything else as an error', async () => {
      failWith({ kind: 'transient', message: 'unreachable', terminal: false })

      await connectTunnel('ssh1', 'Box')

      expect($notifications.get()).toEqual([expect.objectContaining({ kind: 'error', title: 'Box needs sign-in' })])
    })
  })

  describe('an answer given during Connect', () => {
    it('is kept for this connection when it is a passphrase or password on its own attempt', async () => {
      const saved: unknown[] = []
      const off = setTunnelAnswerSaver(async (connectionId, answer) => saved.push([connectionId, answer]))

      let finish = (_value: unknown) => {}

      withPageOpen((command: string) =>
        command === 'tunnel_acquire' ? new Promise(resolve => (finish = resolve)) : Promise.resolve(undefined)
      )

      try {
        const connecting = connectTunnel('ssh1', 'Box')

        await vi.waitFor(() => expect(calls('tunnel_acquire')).toHaveLength(1))

        for (const listener of answerListeners) {
          listener({ attemptId: 'attempt-7', kind: 'passphrase' }, 'open sesame')
          listener({ attemptId: 'attempt-7', kind: 'keyboard-interactive' }, '123456')
          listener({ attemptId: 'someone-else', kind: 'password' }, 'not ours')
        }

        finish(descriptor)
        await connecting
      } finally {
        off()
      }

      expect(saved).toEqual([['ssh1', { passphrase: 'open sesame' }]])
      expect(answerListeners.size).toBe(0)
    })
  })

  // The one keeper a tunnel's Connect and a switch's preflight share (S2).
  describe('keepTunnelAnswers', () => {
    it("keeps its own attempt's passphrase or password, until it is stopped", () => {
      const saved: unknown[] = []
      const off = setTunnelAnswerSaver(async (connectionId, answer) => saved.push([connectionId, answer]))

      const answer = (attemptId: string, kind: string, text: string) =>
        [...answerListeners].forEach(listener => listener({ attemptId, kind }, text))

      try {
        const minted = keepTunnelAnswers('ssh1')
        const named = keepTunnelAnswers('ssh2', 'attempt-9')

        expect([minted.attemptId, named.attemptId]).toEqual(['attempt-7', 'attempt-9'])

        answer('attempt-9', 'password', 'hunter2')
        answer('attempt-9', 'keyboard-interactive', '123456')
        answer('attempt-9', 'passphrase', '')
        named.stop()
        answer('attempt-9', 'password', 'too late')

        expect(saved).toEqual([['ssh2', { password: 'hunter2' }]])

        minted.stop()
        expect(answerListeners.size).toBe(0)
      } finally {
        off()
      }
    })
  })

  it('lets its hold go when the dial fails', async () => {
    withPageOpen(async (command: string) => {
      if (command === 'tunnel_acquire') {
        throw { kind: 'credentials-needed', message: 'needs a passphrase', terminal: true }
      }
    })

    await expect(acquireTunnel('ssh1')).rejects.toMatchObject({ kind: 'credentials-needed' })
    expect(calls('tunnel_release')).toHaveLength(1)
  })
})
