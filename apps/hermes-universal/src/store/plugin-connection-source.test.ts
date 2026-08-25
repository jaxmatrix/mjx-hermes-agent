import { beforeEach, describe, expect, it, vi } from 'vitest'

const listProfilesRich = vi.fn()

vi.mock('@/lib/gateway-rpc', () => ({ listProfilesRich: () => listProfilesRich() }))
vi.mock('@/hermes', () => ({ getStatus: vi.fn(), setApiRequestProfile: vi.fn() }))

import { describeConnection, publishActiveConnection } from './active-connection'
import { $connectionPhase, $hasConnected } from './connection'
import { $gatewayState } from './gateway'
import { $restoring } from './gateway-restore'
import { $gatewaySwitching } from './gateway-switch'
import {
  AGENT_ROUTING_UNAVAILABLE,
  pluginConnectionSource,
  setPluginConnectionSource
} from './plugin-connection-source'

const ROSTER = {
  profiles: [
    { display_name: 'Default', is_default: true, name: 'default' },
    { display_name: 'Work', is_default: false, name: 'work' }
  ]
}

function connect() {
  // Published, not assigned. MJXHRM-446 made `publishActiveConnection` the ONE
  // writer of `$connection`, and it writes the source identity in the same
  // `batch()` — so "usable" now means "usable AND we know which machine".
  // Setting the descriptor by hand reaches a state production cannot be in.
  publishActiveConnection(describeConnection({ baseUrl: 'https://gw.test', mode: 'remote' } as never))
  $connectionPhase.set('ready')
  $gatewayState.set('open')
  $hasConnected.set(true)
  $gatewaySwitching.set(false)
  $restoring.set(false)
}

beforeEach(() => {
  connect()
  listProfilesRich.mockReset().mockResolvedValue(ROSTER)
})

describe('the single-connection source', () => {
  it('describes the live connection — and never its credentials', async () => {
    const [connection] = await pluginConnectionSource().connections()

    expect(connection).toEqual({ id: 'https://gw.test', kind: 'remote', label: 'https://gw.test', primary: true })
    // A hard rule, not a MJXHRM-446 detail: the SDK hands out an identity.
    expect(JSON.stringify(connection)).not.toMatch(/token|password|secret/i)
  })

  it('answers with nothing while the app is not usable', async () => {
    $gatewayState.set('closed')

    expect(await pluginConnectionSource().connections()).toEqual([])
  })

  it('lists one agent per profile on the live connection', async () => {
    const roster = await pluginConnectionSource().agents()

    expect(roster.agents).toEqual([
      { connectionId: 'https://gw.test', isDefault: true, label: 'Default', profile: 'default' },
      { connectionId: 'https://gw.test', isDefault: false, label: 'Work', profile: 'work' }
    ])
    expect(roster.sources).toEqual([{ connectionId: 'https://gw.test', ok: true }])
  })

  // A connection that failed carries its error rather than vanishing: a missing
  // row and a broken row are different facts.
  it('keeps a failed connection on the roster, with its reason', async () => {
    listProfilesRich.mockRejectedValue(new Error('gateway said no'))

    const roster = await pluginConnectionSource().agents()

    expect(roster.agents).toEqual([])
    expect(roster.sources).toEqual([{ connectionId: 'https://gw.test', error: 'gateway said no', ok: false }])
  })

  // The `drive()` rule from MJXHRM-472: an empty answer reads to the caller as
  // "it worked and there is nothing there", which is what a routing failure
  // must never look like.
  it('refuses another connection with a SHAPED error, not an empty success', async () => {
    await expect(pluginConnectionSource().ensureAgent('conn:elsewhere', 'work')).resolves.toEqual({
      error: AGENT_ROUTING_UNAVAILABLE,
      ok: false
    })
  })

  it('refuses a profile the live connection does not have', async () => {
    await expect(pluginConnectionSource().ensureAgent('https://gw.test', 'nope')).resolves.toEqual({
      error: AGENT_ROUTING_UNAVAILABLE,
      ok: false
    })
  })

  it('hands back a handle for a profile it does have', async () => {
    await expect(pluginConnectionSource().ensureAgent('https://gw.test', 'work')).resolves.toEqual({
      connectionId: 'https://gw.test',
      ok: true,
      profile: 'work'
    })
  })

  it('routes one entry per agent', async () => {
    await expect(pluginConnectionSource().profileRoutes()).resolves.toEqual([
      { connectionId: 'https://gw.test', profile: 'default' },
      { connectionId: 'https://gw.test', profile: 'work' }
    ])
  })
})

// MJXHRM-446 registers its own source and edits nothing in `src/sdk/index.ts`.
describe('setPluginConnectionSource', () => {
  it('swaps every answer, and restores the single-connection one on dispose', async () => {
    const registry = {
      agents: vi.fn(async () => ({ agents: [], sources: [] })),
      connections: vi.fn(async () => [{ id: 'a', kind: 'ssh', label: 'A', primary: false }]),
      ensureAgent: vi.fn(async () => ({ connectionId: 'a', ok: true as const, profile: 'p' })),
      profileRoutes: vi.fn(async () => [])
    }

    const dispose = setPluginConnectionSource(registry)

    expect(await pluginConnectionSource().connections()).toEqual([
      { id: 'a', kind: 'ssh', label: 'A', primary: false }
    ])

    dispose()

    expect((await pluginConnectionSource().connections())[0]?.id).toBe('https://gw.test')
  })
})
