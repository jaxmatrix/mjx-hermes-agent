import { beforeEach, describe, expect, it, vi } from 'vitest'

const { confirm, connectLocal, notify, requestGateway, restartLocalBackend } = vi.hoisted(() => ({
  confirm: vi.fn(),
  connectLocal: vi.fn(async () => {}),
  notify: vi.fn(),
  requestGateway: vi.fn(),
  restartLocalBackend: vi.fn(async () => ({}))
}))

vi.mock('@/store/confirm', () => ({ confirm }))
vi.mock('@/store/connection', async () => {
  const { atom } = await import('@/store/atom')

  return { $connection: atom<unknown>({ baseUrl: 'http://127.0.0.1:1', mode: 'local' }), connectLocal }
})
vi.mock('@/store/gateway', () => ({ requestGateway }))
vi.mock('@/store/local-backend', () => ({ restartLocalBackend }))
vi.mock('@/store/notifications', () => ({ notify }))

import { $gatewayMode } from '@/store/gateway-switch'

import { announceProfileChatScope, restartLocalBackendConfirmed } from './profile-chat-scope'

beforeEach(() => {
  for (const spy of [confirm, connectLocal, notify, requestGateway, restartLocalBackend]) {
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

    expect(notify.mock.calls[0]?.[0]).toMatchObject({ action: { label: 'Restart backend' } })
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

    await expect(restartLocalBackendConfirmed('work')).resolves.toBe(false)

    expect(requestGateway).toHaveBeenCalledWith('session.active_list', {})
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]?.[0].description).toContain('Release notes, Room: planning')
    expect(confirm.mock.calls[0]?.[0].description).not.toContain('Old chat')
    expect(restartLocalBackend).not.toHaveBeenCalled()
  })

  it('restarts and reconnects once confirmed', async () => {
    requestGateway.mockResolvedValue({ sessions: [{ status: 'working', title: 'Release notes' }] })
    confirm.mockResolvedValue(true)

    await expect(restartLocalBackendConfirmed('work')).resolves.toBe(true)

    expect(restartLocalBackend).toHaveBeenCalledTimes(1)
    expect(connectLocal).toHaveBeenCalledWith('work')
  })

  it('restarts without asking when nothing is live', async () => {
    requestGateway.mockResolvedValue({ sessions: [{ status: 'idle', title: 'Old chat' }] })

    await restartLocalBackendConfirmed(null)

    expect(confirm).not.toHaveBeenCalled()
    expect(restartLocalBackend).toHaveBeenCalledTimes(1)
  })
})
