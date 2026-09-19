import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionView } from '@/store/connections'

// The union roster and the plugin routes: Rust's enumeration joined with the
// registry's kinds and labels, in desktop's shape.

const base = {
  hasSshKey: false,
  hasSshPassphrase: false,
  hasSshPassword: false,
  hasToken: false,
  headerNames: [],
  legacy: false
}

const ROWS: ConnectionView[] = [
  { ...base, id: 'local', kind: 'local', label: 'This device', order: 0 },
  { ...base, id: 'home', kind: 'remote', label: 'Homelab', order: 1, url: 'https://home.test' },
  { ...base, host: 'box', id: 'box', kind: 'ssh', label: 'Box', order: 2, remoteProfile: 'work' }
]

const store = vi.hoisted(() => ({
  $registryView: { get: vi.fn() },
  connectionsRoster: vi.fn(),
  refreshConnections: vi.fn()
}))

vi.mock('@/store/connections', () => store)

import { rosterBridge as bridge, sourceError } from './roster'

const registry = (connections: ConnectionView[]) => ({ connections })

beforeEach(() => {
  vi.clearAllMocks()
  store.$registryView.get.mockReturnValue(registry(ROWS))
  store.connectionsRoster.mockResolvedValue({
    agents: [
      { connectionId: 'local', handle: 'default', isDefault: true, label: 'This device', profile: 'default' },
      { connectionId: 'home', handle: 'work-homelab', isDefault: false, label: 'Homelab', profile: 'work' },
      { connectionId: 'box', handle: 'work-box', isDefault: false, label: 'Box', profile: 'work' },
      { connectionId: 'gone', handle: 'x', isDefault: false, label: 'Gone', profile: 'x' }
    ],
    sources: [
      { connectionId: 'local', observed: true, ok: true },
      {
        connectionId: 'home',
        error: 'error sending request for url (https://home.test/api/profiles)',
        observed: true,
        ok: true
      },
      { connectionId: 'box', error: 'connect-on-demand', observed: false, ok: true },
      { connectionId: 'gone', observed: false, ok: false }
    ]
  })
})

describe('getAgentRoster', () => {
  it('joins Rust’s rows with each source’s kind and label, and drops a row that has left', async () => {
    const roster = await bridge.getAgentRoster()

    expect(roster.agents).toEqual([
      {
        connectionId: 'local',
        connectionKind: 'local',
        connectionLabel: 'This device',
        handle: 'default',
        profile: 'default'
      },
      {
        connectionId: 'home',
        connectionKind: 'remote',
        connectionLabel: 'Homelab',
        handle: 'work-homelab',
        profile: 'work'
      },
      { connectionId: 'box', connectionKind: 'ssh', connectionLabel: 'Box', handle: 'work-box', profile: 'work' }
    ])
    expect(roster.sources).toEqual([
      { connectionId: 'local', kind: 'local', label: 'This device', reachable: true },
      { connectionId: 'home', error: 'unreachable', kind: 'remote', label: 'Homelab', reachable: true },
      // Desktop's token for "clickable, never dialled from a poll".
      { connectionId: 'box', error: 'connect-on-demand', kind: 'ssh', label: 'Box', reachable: true }
    ])
    expect(JSON.stringify(roster)).not.toContain('home.test')
  })

  it('reads the registry it has, and loads it only when there is none', async () => {
    await bridge.getAgentRoster()

    expect(store.refreshConnections).not.toHaveBeenCalled()

    store.$registryView.get.mockReturnValue(registry([]))
    store.refreshConnections.mockResolvedValueOnce(registry(ROWS))

    expect((await bridge.getAgentRoster()).agents).toHaveLength(3)
    expect(store.refreshConnections).toHaveBeenCalledOnce()
  })

  it.each([
    ['connect-on-demand', 'connect-on-demand'],
    ['not-running', 'not-running'],
    ['timeout', 'timeout'],
    ['HTTP 401', 'HTTP 401'],
    ['tcp connect error: 10.0.0.4:443', 'unreachable'],
    [undefined, undefined]
  ])('passes a source error on only when it is a token: %s', (error, expected) => {
    expect(sourceError(error)).toBe(expected)
  })
})

describe('getProfileRoutes', () => {
  it('is one credential-free route per source and profile, the profile its own target', async () => {
    expect(await bridge.getProfileRoutes(['default'])).toEqual([
      { connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' },
      { connectionId: 'home', mode: 'remote', profile: 'work', targetProfile: 'work' },
      { connectionId: 'box', mode: 'remote', profile: 'work', targetProfile: 'work' }
    ])
  })

  it('keeps the caller’s cached local profiles when the local enumeration failed — and only then', async () => {
    store.connectionsRoster.mockResolvedValueOnce({
      agents: [],
      sources: [{ connectionId: 'local', error: 'not-running', observed: false, ok: false }]
    })

    expect(await bridge.getProfileRoutes(['default', ' work ', '', 'default'])).toEqual([
      { connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' },
      { connectionId: 'local', mode: 'local', profile: 'work', targetProfile: 'work' }
    ])

    expect((await bridge.getProfileRoutes(['ghost'])).some(route => route.profile === 'ghost')).toBe(false)
  })
})
