import { beforeEach, describe, expect, it, vi } from 'vitest'

// Observe which connect path the boot restore dials, without real networking.
vi.mock('@/store/connection', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  connectCloud: vi.fn().mockResolvedValue(undefined),
  connectLocal: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  loadSavedLogin: vi.fn().mockResolvedValue({ token: 'T', password: 'P' }),
}))

import { connect, connectCloud, connectLocal } from '@/store/connection'

import {
  $restoring,
  autoRestoreConnection,
  clearGatewayTarget,
  loadGatewayTarget,
  saveGatewayTarget,
} from './gateway-restore'

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('gateway target persistence', () => {
  it('round-trips through localStorage', () => {
    saveGatewayTarget({ mode: 'remote', url: 'host:1', username: 'admin' })
    expect(loadGatewayTarget()).toMatchObject({ mode: 'remote', url: 'host:1', username: 'admin' })
  })

  it('clear removes it', () => {
    saveGatewayTarget({ mode: 'local' })
    clearGatewayTarget()
    expect(loadGatewayTarget()).toBeNull()
  })

  it('ignores malformed / non-mode json', () => {
    localStorage.setItem('hermes.connection.last', '{bad')
    expect(loadGatewayTarget()).toBeNull()
    localStorage.setItem('hermes.connection.last', JSON.stringify({ mode: 'bogus' }))
    expect(loadGatewayTarget()).toBeNull()
  })
})

describe('autoRestoreConnection', () => {
  it('no saved target → dials nothing and clears $restoring', async () => {
    await autoRestoreConnection()
    expect(connect).not.toHaveBeenCalled()
    expect(connectLocal).not.toHaveBeenCalled()
    expect(connectCloud).not.toHaveBeenCalled()
    expect($restoring.get()).toBe(false)
  })

  it('remote target → connect() with the keyring secrets', async () => {
    saveGatewayTarget({ mode: 'remote', url: 'host:1', username: 'admin' })
    await autoRestoreConnection()
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'host:1', username: 'admin', token: 'T', password: 'P' })
    )
    expect($restoring.get()).toBe(false)
  })

  it('local target → connectLocal(profile)', async () => {
    saveGatewayTarget({ mode: 'local', profile: 'dev' })
    await autoRestoreConnection()
    expect(connectLocal).toHaveBeenCalledWith('dev')
  })

  it('cloud target → connectCloud(baseUrl)', async () => {
    saveGatewayTarget({ mode: 'cloud', cloudBaseUrl: 'https://a1', cloudAgentName: 'Atlas' })
    await autoRestoreConnection()
    expect(connectCloud).toHaveBeenCalledWith('https://a1', null)
  })

  it('clears $restoring even when the dial throws', async () => {
    vi.mocked(connect).mockRejectedValueOnce(new Error('unreachable'))
    saveGatewayTarget({ mode: 'remote', url: 'host:1' })
    await autoRestoreConnection()
    expect($restoring.get()).toBe(false)
  })
})
