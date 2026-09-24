import { beforeEach, describe, expect, it, vi } from 'vitest'

const { confirm, notify, requestGateway, restartLocalBackend } = vi.hoisted(() => ({
  confirm: vi.fn(),
  notify: vi.fn(),
  requestGateway: vi.fn(),
  restartLocalBackend: vi.fn(async () => ({}))
}))

vi.mock('@/store/confirm', () => ({ confirm }))
vi.mock('@/store/connection', async () => {
  const { atom } = await import('@/store/atom')

  return { $connection: atom<unknown>({ baseUrl: 'http://127.0.0.1:1', mode: 'local' }) }
})
vi.mock('@/store/gateway-client', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    requestGateway
  }
})
vi.mock('@/store/local-backend', () => ({ restartLocalBackend }))
vi.mock('@/store/notifications', () => ({ notify }))

import { $gatewayMode } from '@/store/gateway-mode'

import { announceProfileChatScope, restartLocalBackendConfirmed } from './profile-chat-scope'

beforeEach(() => {
  for (const spy of [confirm, notify, requestGateway, restartLocalBackend]) {
    spy.mockClear()
  }
})

describe('a profile change', () => {
  // MJXHRM-592: SSH runs the unified backend, so a profile change re-scopes
  // requests and never respawns the remote backend.
  it('on SSH only says what moved, with nothing to restart', () => {
    $gatewayMode.set('ssh')

    announceProfileChatScope('work')

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0]).not.toHaveProperty('action')
  })

  it('on local offers "Restart backend"', () => {
    $gatewayMode.set('local')

    announceProfileChatScope('work')

    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      action: { label: 'settings.connections.profileRestartAction' }
    })
  })
})

describe('Restart backend', () => {
  it('names the live work and does nothing when the answer is no', async () => {
    requestGateway.mockResolvedValue({
      sessions: [
        { status: 'working', title: 'Release notes' },
        { status: 'waiting', title: 'Room: planning' },
        { status: 'idle', title: 'Old chat' }
      ]
    })
    confirm.mockResolvedValue(false)

    await expect(restartLocalBackendConfirmed()).resolves.toBe(false)

    expect(requestGateway).toHaveBeenCalledWith('session.active_list', {})
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]?.[0].description).toBe('settings.connections.restartLocalDescription')
    expect(confirm.mock.calls[0]?.[0].description).not.toContain('Old chat')
    expect(restartLocalBackend).not.toHaveBeenCalled()
  })

  // No reconnect of its own: the fold's primary socket follows its tunnel lease.
  it('restarts once confirmed', async () => {
    requestGateway.mockResolvedValue({ sessions: [{ status: 'working', title: 'Release notes' }] })
    confirm.mockResolvedValue(true)

    await expect(restartLocalBackendConfirmed()).resolves.toBe(true)

    expect(restartLocalBackend).toHaveBeenCalledTimes(1)
  })

  it('restarts without asking when nothing is live', async () => {
    requestGateway.mockResolvedValue({ sessions: [{ status: 'idle', title: 'Old chat' }] })

    await restartLocalBackendConfirmed()

    expect(confirm).not.toHaveBeenCalled()
    expect(restartLocalBackend).toHaveBeenCalledTimes(1)
  })
})
