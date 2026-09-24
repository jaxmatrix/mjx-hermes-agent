import { afterEach, describe, expect, it, vi } from 'vitest'

const { attachSshPrompts, connectSshBackend, onSshDisconnected } = vi.hoisted(() => ({
  attachSshPrompts: vi.fn(async () => () => {}),
  connectSshBackend: vi.fn(),
  onSshDisconnected: vi.fn(async () => () => {})
}))

vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))
vi.mock('@/store/gateway-client', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    closeGateway: vi.fn(),
    connectGateway: vi.fn().mockResolvedValue(undefined),
    lastGatewayCloseCode: vi.fn(() => undefined),
    $gatewayState: atom('idle')
  }
})
vi.mock('@/lib/secure-store', () => ({
  clearSecrets: vi.fn().mockResolvedValue(undefined),
  loadSecrets: vi.fn().mockResolvedValue(null),
  loadSshSecrets: vi.fn().mockResolvedValue({}),
  saveSecrets: vi.fn().mockResolvedValue(true)
}))
vi.mock('@/store/installation-id', () => ({ getInstallationId: vi.fn(async () => 'a'.repeat(32)) }))
vi.mock('@/store/local-backend', () => ({ spawnLocalBackend: vi.fn(), stopLocalBackend: vi.fn() }))
vi.mock('@/store/ssh-backend', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  attachSshPrompts,
  connectSshBackend,
  onSshDisconnected,
  onSshProgress: vi.fn(async () => () => {})
}))

import { $connection, connectSsh } from './connection'

const BACKEND = {
  baseUrl: 'http://127.0.0.1:41000',
  hostLabel: 'deploy@box',
  ownershipId: 'own-1',
  scope: 'conn:box::default',
  token: 'T',
  wsUrl: 'ws://127.0.0.1:41000/api/ws?token=T'
}

afterEach(() => vi.clearAllMocks())

describe('connectSsh', () => {
  // MJXHRM-592: one backend per connection. The watchdog listens where Rust put
  // the session, never on a scope rebuilt here from the profile.
  it('watches the scope Rust dialled, whatever the profile', async () => {
    connectSshBackend.mockResolvedValue(BACKEND)

    await connectSsh({ host: 'box', profile: 'work' })

    expect(onSshDisconnected).toHaveBeenCalledWith('conn:box::default', expect.any(Function))
    expect($connection.get()).toMatchObject({ sshScope: 'conn:box::default' })
  })

  it("puts an interactive dial's questions on screen before it dials", async () => {
    connectSshBackend.mockResolvedValue(BACKEND)

    await connectSsh({ host: 'box' }, { attemptId: 'a1', interactive: true })

    expect(attachSshPrompts).toHaveBeenCalledWith('a1')
    expect(attachSshPrompts.mock.invocationCallOrder[0]).toBeLessThan(connectSshBackend.mock.invocationCallOrder[0])

    attachSshPrompts.mockClear()
    await connectSsh({ host: 'box' }, { attemptId: 'a2' })

    expect(attachSshPrompts).not.toHaveBeenCalled()
  })
})
