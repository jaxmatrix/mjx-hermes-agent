import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { attachSshPrompts, handlers, httpRequest, invoke, platform } = vi.hoisted(() => ({
  attachSshPrompts: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  httpRequest: vi.fn(),
  invoke: vi.fn(),
  platform: { mobile: false }
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
  }
}))
vi.mock('@/store/installation-id', () => ({ getInstallationId: vi.fn(async () => 'a'.repeat(32)) }))
vi.mock('@/store/ssh-backend', () => ({
  attachSshPrompts,
  newAttemptId: () => 'attempt-7',
  onSshProgress: vi.fn(async () => () => {})
}))
vi.mock('@/store/windows', () => ({ isActivityWindow: () => false, isSatelliteWindow: () => false }))
vi.mock('@/transport/http', () => ({ httpRequest }))

import { api, setConnectionBaseResolver } from '@/lib/api'
import { $notifications } from '@/store/notifications'

import {
  $tunnelStatus,
  __testing,
  acquireTunnel,
  connectionBase,
  needsInteraction,
  TOUCH_INTERVAL_MS,
  type TunnelStatus
} from './connection-tunnels'

const descriptor = {
  baseUrl: 'http://127.0.0.1:41000',
  connectionId: 'ssh1',
  generation: 1,
  instanceKey: 'ssh:deploy@box:22'
}

const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command)

beforeEach(() => {
  __testing.reset()
  handlers.clear()
  invoke.mockReset()
  attachSshPrompts.mockReset()
  httpRequest.mockReset()
  platform.mobile = false
  $notifications.set([])
  invoke.mockImplementation(async (command: string) => (command === 'tunnel_acquire' ? descriptor : undefined))
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

  it('keeps telling Rust the lease is held, and hears when Rust forgot it', async () => {
    vi.useFakeTimers()

    const lease = await acquireTunnel('ssh1')
    const closed = vi.fn()

    lease.onClosed(closed)
    await vi.advanceTimersByTimeAsync(TOUCH_INTERVAL_MS)

    expect(calls('tunnel_touch')).toEqual([
      [
        'tunnel_touch',
        { connectionId: 'ssh1', leaseId: (calls('tunnel_acquire')[0]?.[1] as { leaseId: string }).leaseId }
      ]
    ])
    expect(closed).not.toHaveBeenCalled()

    invoke.mockImplementation(async (command: string) => (command === 'tunnel_touch' ? false : undefined))
    await vi.advanceTimersByTimeAsync(TOUCH_INTERVAL_MS)

    expect(closed).toHaveBeenCalledTimes(1)

    lease.release()
    await vi.advanceTimersByTimeAsync(TOUCH_INTERVAL_MS * 2)

    expect(calls('tunnel_touch')).toHaveLength(2)
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
    invoke.mockImplementation(async (command: string, args: { interactive?: boolean }) => {
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
  })

  it('raises nothing for a failure that retrying can fix', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'tunnel_acquire') {
        throw { kind: 'transient', message: 'unreachable', terminal: false }
      }
    })

    await expect(acquireTunnel('ssh1', { label: 'Box' })).rejects.toMatchObject({ kind: 'transient' })
    expect($notifications.get()).toHaveLength(0)
  })

  it('lets its hold go when the dial fails', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'tunnel_acquire') {
        throw { kind: 'credentials-needed', message: 'needs a passphrase', terminal: true }
      }
    })

    await expect(acquireTunnel('ssh1')).rejects.toMatchObject({ kind: 'credentials-needed' })
    expect(calls('tunnel_release')).toHaveLength(1)
  })
})
