import { beforeEach, describe, expect, it, vi } from 'vitest'

const connectionsRoster = vi.fn()
const leaseSecondary = vi.fn()
const releaseSecondary = vi.fn()

vi.mock('@/store/connections', async importOriginal => {
  const actual = await importOriginal<typeof import('@/store/connections')>()

  return {
    ...actual,
    connectionsRoster: (...args: unknown[]) => connectionsRoster(...args)
  }
})

vi.mock('@/store/gateway-secondaries', () => ({
  leaseSecondary: (...args: unknown[]) => leaseSecondary(...args),
  releaseSecondary: (...args: unknown[]) => releaseSecondary(...args)
}))

import { $activeConnection } from './active-connection'
import { $registryView } from './connections'
import { AGENT_ROUTING_UNAVAILABLE, pluginConnectionSource } from './plugin-connection-source'

/** Installs registryConnectionSource via module side effect. */
const { registryConnectionSource } = await import('./connection-plugin-source')

function seedTwoGateways(): void {
  $registryView.set({
    connections: [
      {
        hasSshKey: false,
        hasSshPassphrase: false,
        hasSshPassword: false,
        hasToken: false,
        headerNames: [],
        id: 'https://gw-a.test',
        kind: 'remote',
        label: 'Gateway A',
        legacy: false,
        order: 0,
        url: 'https://gw-a.test'
      },
      {
        hasSshKey: false,
        hasSshPassphrase: false,
        hasSshPassword: false,
        hasToken: false,
        headerNames: [],
        id: 'https://gw-b.test',
        kind: 'remote',
        label: 'Gateway B',
        legacy: false,
        order: 1,
        url: 'https://gw-b.test'
      }
    ],
    keyringAvailable: true,
    lastUsed: 'https://gw-a.test',
    launchMode: 'last-used',
    localSupported: true,
    primary: 'https://gw-a.test',
    readOnly: false,
    version: 2
  })

  // Active route is A — B must still appear on the union roster.
  $activeConnection.set({
    connection: { baseUrl: 'https://gw-a.test', mode: 'remote' } as never,
    connectionId: 'https://gw-a.test',
    dialConnectionId: 'https://gw-a.test',
    kind: 'remote',
    label: 'Gateway A',
    profile: 'default',
    scopeKey: 'conn:https://gw-a.test::default'
  })
}

beforeEach(() => {
  seedTwoGateways()

  connectionsRoster.mockReset().mockResolvedValue({
    agents: [
      {
        connectionId: 'https://gw-a.test',
        handle: 'default',
        isDefault: true,
        label: 'Default',
        profile: 'default'
      },
      {
        connectionId: 'https://gw-b.test',
        handle: 'worker',
        isDefault: true,
        label: 'Worker',
        profile: 'worker'
      }
    ],
    sources: [
      { connectionId: 'https://gw-a.test', observed: true, ok: true },
      { connectionId: 'https://gw-b.test', observed: true, ok: true }
    ]
  })

  leaseSecondary.mockReset().mockResolvedValue({ id: 'lease-b' })
  releaseSecondary.mockReset()
})

describe('registryConnectionSource (multi-gateway)', () => {
  it('is installed as the live pluginConnectionSource', async () => {
    expect(pluginConnectionSource()).toBe(registryConnectionSource)
  })

  it('lists connections from the registry — primary is the active route', async () => {
    const rows = await pluginConnectionSource().connections()

    expect(rows).toEqual([
      { id: 'https://gw-a.test', kind: 'remote', label: 'Gateway A', primary: true },
      { id: 'https://gw-b.test', kind: 'remote', label: 'Gateway B', primary: false }
    ])
  })

  it('unions agents from every gateway while only one is active', async () => {
    const roster = await pluginConnectionSource().agents()

    expect(roster.agents.map(agent => agent.connectionId).sort()).toEqual([
      'https://gw-a.test',
      'https://gw-b.test'
    ])
    expect(roster.agents.find(agent => agent.connectionId === 'https://gw-b.test')?.profile).toBe('worker')
    // Desktop-shaped sources so Bot Mode annotateBotSource can badge rows.
    expect(roster.sources).toEqual([
      {
        connectionId: 'https://gw-a.test',
        error: undefined,
        kind: 'remote',
        label: 'Gateway A',
        observed: true,
        ok: true,
        reachable: true
      },
      {
        connectionId: 'https://gw-b.test',
        error: undefined,
        kind: 'remote',
        label: 'Gateway B',
        observed: true,
        ok: true,
        reachable: true
      }
    ])
  })

  it('maps connect-on-demand as reachable with that error (On demand badge)', async () => {
    connectionsRoster.mockResolvedValueOnce({
      agents: [
        {
          connectionId: 'https://gw-b.test',
          handle: 'worker',
          isDefault: true,
          label: 'Worker',
          profile: 'worker'
        }
      ],
      sources: [
        {
          connectionId: 'https://gw-b.test',
          error: 'connect-on-demand',
          observed: false,
          ok: true
        }
      ]
    })

    const roster = await pluginConnectionSource().agents()
    const source = roster.sources.find(row => row.connectionId === 'https://gw-b.test')

    expect(source).toMatchObject({
      error: 'connect-on-demand',
      kind: 'remote',
      label: 'Gateway B',
      observed: false,
      ok: true,
      reachable: true
    })
  })

  it('ensureAgent on the active connection needs no secondary lease', async () => {
    await expect(pluginConnectionSource().ensureAgent('https://gw-a.test', 'default')).resolves.toEqual({
      connectionId: 'https://gw-a.test',
      ok: true,
      profile: 'default'
    })
    expect(leaseSecondary).not.toHaveBeenCalled()
  })

  it('ensureAgent on another logged-in gateway leases a secondary socket', async () => {
    await expect(pluginConnectionSource().ensureAgent('https://gw-b.test', 'worker')).resolves.toEqual({
      connectionId: 'https://gw-b.test',
      ok: true,
      profile: 'worker'
    })
    expect(leaseSecondary).toHaveBeenCalled()
    expect(releaseSecondary).toHaveBeenCalledWith({ id: 'lease-b' })
  })

  it('refuses an unknown connection with a shaped error', async () => {
    await expect(pluginConnectionSource().ensureAgent('conn:missing', 'default')).resolves.toEqual({
      error: AGENT_ROUTING_UNAVAILABLE,
      ok: false
    })
  })

  it('refuses when the secondary lease cannot be obtained', async () => {
    leaseSecondary.mockRejectedValueOnce(new Error('unreachable'))

    await expect(pluginConnectionSource().ensureAgent('https://gw-b.test', 'worker')).resolves.toEqual({
      error: AGENT_ROUTING_UNAVAILABLE,
      ok: false
    })
  })
})
