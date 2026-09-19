import { beforeEach, describe, expect, it, vi } from 'vitest'

// A REAL select, the REAL `connection-applied` emitter and the REAL bridge, end
// to end: what the boot hook reads when the switch tells it to soft-switch
// (`profile.get`, `getConnection`) is the identity the select just published.
// Only Rust (`invoke`), the tunnels and the peer broadcast channel are faked —
// the unit tests on either side each fake the other half.

const { acquireTunnel, invoke, rows } = vi.hoisted(() => ({
  acquireTunnel: vi.fn(),
  invoke: vi.fn(),
  rows: new Map<string, Record<string, unknown>>()
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }))
vi.mock('@/lib/platform', async importOriginal => ({ ...(await importOriginal<object>()), IS_TAURI: true }))
vi.mock('@/store/connection-tunnels', async () => ({
  $tunnelStatus: (await import('nanostores')).map({}),
  acquireTunnel,
  connectionBase: vi.fn(),
  liveTunnelBase: vi.fn(() => null),
  openTunnelPage: vi.fn(),
  setTunnelAnswerSaver: vi.fn()
}))

import { onConnectionApplied } from '@/lib/hermes-desktop/connection-applied'
import { connectionBridge as bridge } from '@/lib/hermes-desktop/connections'
import { socketProfile } from '@/transport/gateway-profile'

import { $activeConnection, publishActiveConnection } from './active-connection'
import { __testing, restoreLaunchConnection, selectConnection } from './connections'

const registry = () => ({
  connections: [...rows.keys()].map((id, order) => ({
    headerNames: [],
    id,
    kind: rows.get(id)?.kind,
    label: id,
    order
  })),
  keyringAvailable: true,
  lastUsed: [...rows.keys()][0],
  launchMode: 'last-used',
  localSupported: true,
  primary: [...rows.keys()][0],
  readOnly: false,
  version: 2
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  __testing.reset()
  publishActiveConnection(null)
  rows.clear()
  rows.set('home', { baseUrl: 'https://home.test', kind: 'remote', mode: 'remote' })
  // An SSH row migrated with a profile of its own (`remote_profile`).
  rows.set('box', { kind: 'ssh', mode: 'ssh', remoteHost: 'me@box', remoteProfile: 'work' })

  acquireTunnel.mockImplementation(async () => ({
    baseUrl: () => 'http://127.0.0.1:4100',
    release: vi.fn(),
    wsUrl: () => 'ws://127.0.0.1:4100/api/ws'
  }))

  // Rust: `connections_resolve` names the profile asked for, else the row's own.
  invoke.mockImplementation(async (command: string, args: { connectionId?: string; profile?: null | string } = {}) => {
    if (command === 'connections_resolve') {
      const { remoteProfile, ...row } = rows.get(String(args.connectionId)) ?? {}

      return {
        ...row,
        connectionId: args.connectionId,
        dialConnectionId: args.connectionId,
        headerNames: [],
        label: args.connectionId,
        profile: args.profile ?? remoteProfile,
        tokenAttached: false
      }
    }

    // An ungated gateway's status probe.
    if (command === 'http_request') {
      return { body: JSON.stringify({ auth_required: false }), headers: {}, status: 200 }
    }

    return command.startsWith('connections_') ? registry() : undefined
  })
})

describe('a switch, as the boot hook sees it', () => {
  it('answers the soft switch with the profile of the identity the select published', async () => {
    await selectConnection('home')

    expect(await bridge.profile.get()).toEqual({ profile: 'default' })

    // The hook's `softSwitch`, reduced to the two questions it asks the bridge.
    const asked: Promise<[{ profile: null | string }, string]>[] = []

    const off = onConnectionApplied(() => {
      asked.push(Promise.all([bridge.profile.get(), bridge.getConnection().then(conn => conn.wsUrl)]))
    })

    await selectConnection('box')
    off()

    const [adopted, wsUrl] = await asked[0]

    // Never used, so the row's own profile — ONE derivation: the identity, the
    // profile the hook adopts and the one the socket names are the same value.
    expect($activeConnection.get()).toMatchObject({ connectionId: 'box', profile: 'work' })
    expect(adopted).toEqual({ profile: 'work' })
    expect(socketProfile(wsUrl)).toBe('work')
  })

  it('re-reads it on the next switch: the profile the source was last used on', async () => {
    await selectConnection('box')
    // The rail moved this source to `play` mid-life (the hook's `profile.remember`).
    await bridge.profile.remember('play')

    // …which does not re-scope the live primary,
    expect(await bridge.profile.get()).toEqual({ profile: 'work' })

    // …and is where the source reopens.
    await selectConnection('home')
    await selectConnection('box')

    expect(await bridge.profile.get()).toEqual({ profile: 'play' })
    expect(socketProfile((await bridge.getConnection()).wsUrl)).toBe('play')
  })

  it('cold-launches a migrated SSH row on one profile, not two', async () => {
    rows.delete('home')

    await restoreLaunchConnection(true)

    expect($activeConnection.get()).toMatchObject({ connectionId: 'box', profile: 'work', scopeKey: 'conn:box::work' })
    expect(await bridge.profile.get()).toEqual({ profile: 'work' })
    expect(socketProfile((await bridge.getConnection()).wsUrl)).toBe('work')
  })
})
