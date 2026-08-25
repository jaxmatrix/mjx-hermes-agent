import { beforeEach, describe, expect, it, vi } from 'vitest'

const { broadcastGatewaySwitch, connect, connectCloud, connectLocal, connectSsh, invoke, notify, softSwitchGateway } =
  vi.hoisted(() => ({
    broadcastGatewaySwitch: vi.fn(),
    connect: vi.fn(async () => {}),
    connectCloud: vi.fn(async () => {}),
    connectLocal: vi.fn(async () => {}),
    connectSsh: vi.fn(async () => {}),
    invoke: vi.fn(),
    notify: vi.fn(),
    softSwitchGateway: vi.fn(async (_mode: string, dial: () => Promise<void>) => dial())
  }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }))
vi.mock('@/hermes', () => ({ setApiRequestProfile: vi.fn() }))
vi.mock('@/store/connection', () => ({ connect, connectCloud, connectLocal, connectSsh }))
vi.mock('@/store/gateway-soft-switch', () => ({ softSwitchGateway }))
vi.mock('@/store/gateway-switch-broadcast', () => ({ broadcastGatewaySwitch }))
vi.mock('@/store/notifications', () => ({ notify, notifyError: vi.fn() }))

import { LOCAL_CONNECTION_ID } from '@/lib/backend-scope'

import {
  $activeConnection,
  describeConnection,
  publishActiveConnection,
  takePendingConnectionHint
} from './active-connection'
import { $latchedConnections, __resetConnectionLatches } from './connection-latches'
import { $connectionsRegistry, $hasMultipleConnections, __testing, lastProfileFor, selectConnection } from './connections'

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

function seedRegistry(ids: string[]): void {
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
    version: 2
  })
}

beforeEach(() => {
  for (const spy of [broadcastGatewaySwitch, connect, invoke, notify, softSwitchGateway]) {
    spy.mockClear()
  }

  __testing.reset()
  __resetConnectionLatches()
  takePendingConnectionHint()
  publishActiveConnection(null)
  invoke.mockImplementation(async (command: string) => (command === 'connections_resolve' ? RESOLVED : undefined))
  // The dial publishes the identity the way the real connect helpers do.
  softSwitchGateway.mockImplementation(async (_mode: string, dial: () => Promise<void>) => {
    await dial()
    const hint = takePendingConnectionHint()

    publishActiveConnection(
      describeConnection({ authMode: 'none', baseUrl: RESOLVED.baseUrl, mode: 'remote' }, hint)
    )
  })
})

describe('$hasMultipleConnections', () => {
  it('is the ONE gate for source chrome, and is false for a single-source install', () => {
    seedRegistry([LOCAL_CONNECTION_ID])
    expect($hasMultipleConnections.get()).toBe(false)

    seedRegistry([LOCAL_CONNECTION_ID, 'studio'])
    expect($hasMultipleConnections.get()).toBe(true)
  })
})

describe('selectConnection', () => {
  beforeEach(() => {
    seedRegistry([LOCAL_CONNECTION_ID, 'studio'])
  })

  it('publishes the resolved identity and remembers the switch', async () => {
    await selectConnection('studio')

    expect($activeConnection.get()?.connectionId).toBe('studio')
    expect(invoke).toHaveBeenCalledWith('connections_set_last_used', { connectionId: 'studio' })
    expect(broadcastGatewaySwitch).not.toHaveBeenCalled() // no saved target in this env
  })

  it('is a no-op except for lastUsed when the same source is re-clicked', async () => {
    await selectConnection('studio')
    softSwitchGateway.mockClear()

    await selectConnection('studio')

    // A re-dial would drop a live socket for nothing.
    expect(softSwitchGateway).not.toHaveBeenCalled()
  })

  it('refuses a LATCHED source and says why instead of re-entering the retry loop', async () => {
    $latchedConnections.set({ studio: 'host-key-changed' })

    await selectConnection('studio')

    expect(softSwitchGateway).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
  })

  it('never remembers a failed switch', async () => {
    softSwitchGateway.mockRejectedValue(new Error('dial failed'))

    await selectConnection('studio')

    expect(invoke).not.toHaveBeenCalledWith('connections_set_last_used', expect.anything())
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

  it('FAILS OPEN when the identity does not land mid-dial', async () => {
    // The source was edited or removed while connecting: every atom stays on the
    // previous connection and we SAY so (the #89622 silence lesson).
    softSwitchGateway.mockImplementation(async () => {})
    publishActiveConnection(
      describeConnection({ authMode: 'none', baseUrl: 'https://old.test', mode: 'remote' }, {
        connectionId: 'old',
        dialConnectionId: 'old',
        label: 'Old'
      })
    )

    await selectConnection('studio')

    expect($activeConnection.get()?.connectionId).toBe('old')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
  })

  it('lets a LATER click own the outcome while an earlier dial is pending', async () => {
    // Two clicks in flight. The revision guard is what stops the SLOWER one
    // from claiming the switch after the user already moved on.
    let openGate: () => void = () => {}

    const gate = new Promise<void>(resolve => {
      openGate = resolve
    })

    invoke.mockImplementation(async (command: string, args: { connectionId?: string }) =>
      command === 'connections_resolve'
        ? { ...RESOLVED, connectionId: args.connectionId, dialConnectionId: args.connectionId, label: args.connectionId }
        : undefined
    )
    // The connect helper takes its hint SYNCHRONOUSLY, exactly as the real ones
    // do — that is what keeps two overlapping dials from publishing each
    // other's identity.
    connect.mockImplementation(async () => {
      const hint = takePendingConnectionHint()

      publishActiveConnection(
        describeConnection({ authMode: 'none', baseUrl: RESOLVED.baseUrl, mode: 'remote' }, hint)
      )
    })
    softSwitchGateway.mockImplementation(async (_mode: string, dial: () => Promise<void>) => {
      await dial()

      if ($activeConnection.get()?.connectionId === 'studio') {
        await gate
      }
    })

    const first = selectConnection('studio')
    const second = selectConnection(LOCAL_CONNECTION_ID)

    await second
    openGate()
    await first

    // The slow first dial published its descriptor, but its revision is stale,
    // so it does NOT claim the switch.
    expect(invoke).not.toHaveBeenCalledWith('connections_set_last_used', { connectionId: 'studio' })
    expect(invoke).toHaveBeenCalledWith('connections_set_last_used', { connectionId: LOCAL_CONNECTION_ID })
  })

  it('remembers the profile each source was last used on', async () => {
    await selectConnection('studio')

    expect(lastProfileFor('studio')).toBeNull() // 'default' is not remembered

    __testing.rememberProfile('studio', 'work')
    expect(lastProfileFor('studio')).toBe('work')
  })
})
