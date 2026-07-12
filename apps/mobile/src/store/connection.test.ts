import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))
vi.mock('@/lib/auth', () => ({ passwordLogin: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/store/gateway', () => ({
  connectGateway: vi.fn().mockResolvedValue(undefined),
  closeGateway: vi.fn()
}))
vi.mock('@/lib/secure-store', () => ({
  saveSecrets: vi.fn().mockResolvedValue(true),
  loadSecrets: vi.fn().mockResolvedValue({ token: 'T', password: 'P' }),
  clearSecrets: vi.fn().mockResolvedValue(undefined)
}))

import { saveSecrets } from '@/lib/secure-store'
import { httpRequest } from '@/transport/http'

import { connect, loadSavedLogin } from './connection'

const mockHttp = vi.mocked(httpRequest)

beforeEach(() => localStorage.clear())
afterEach(() => vi.clearAllMocks())

describe('connect — secure credential storage', () => {
  it('stores username in localStorage + secrets in the keyring, never plaintext', async () => {
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify({ auth_required: true }) })

    await connect({ url: 'host:1', username: 'admin', password: 'pw' })

    expect(localStorage.getItem('hermes.mobile.username')).toBe('admin')
    expect(localStorage.getItem('hermes.mobile.url')).toBe('host:1')
    // secrets never touch localStorage
    expect(localStorage.getItem('hermes.mobile.password')).toBeNull()
    expect(localStorage.getItem('hermes.mobile.token')).toBeNull()
    expect(saveSecrets).toHaveBeenCalledWith({ token: undefined, password: 'pw' })
  })

  it('loadSavedLogin returns the keyring secrets', async () => {
    expect(await loadSavedLogin()).toEqual({ token: 'T', password: 'P' })
  })
})
