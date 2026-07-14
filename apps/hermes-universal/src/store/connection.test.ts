import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  passwordLogin: vi.fn().mockResolvedValue(undefined),
  oauthLogin: vi.fn().mockResolvedValue(undefined),
  oauthStatus: vi.fn().mockResolvedValue({ signedIn: false }),
  fetchAuthProviders: vi.fn().mockResolvedValue([])
}))
vi.mock('@/store/gateway', () => ({
  connectGateway: vi.fn().mockResolvedValue(undefined),
  closeGateway: vi.fn()
}))
vi.mock('@/lib/secure-store', () => ({
  saveSecrets: vi.fn().mockResolvedValue(true),
  loadSecrets: vi.fn().mockResolvedValue({ token: 'T', password: 'P' }),
  clearSecrets: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/lib/session-persist', () => ({ persistSessionCookies: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/store/local-backend', () => ({
  spawnLocalBackend: vi.fn(),
  stopLocalBackend: vi.fn().mockResolvedValue(undefined)
}))

import { fetchAuthProviders, oauthLogin, oauthStatus, passwordLogin } from '@/lib/auth'
import { saveSecrets } from '@/lib/secure-store'
import { spawnLocalBackend, stopLocalBackend } from '@/store/local-backend'
import { connectGateway } from '@/store/gateway'
import { httpRequest } from '@/transport/http'

import { $connection, connect, connectLocal, disconnect, loadSavedLogin } from './connection'

const mockHttp = vi.mocked(httpRequest)
const mockProviders = vi.mocked(fetchAuthProviders)
const mockOauthLogin = vi.mocked(oauthLogin)
const mockOauthStatus = vi.mocked(oauthStatus)
const mockPasswordLogin = vi.mocked(passwordLogin)

const status = (body: object) => mockHttp.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify(body) })
const passwordProvider = { name: 'basic', display_name: 'Basic', supports_password: true }
const oauthProvider = { name: 'nous', display_name: 'Nous', supports_password: false }

beforeEach(() => localStorage.clear())
afterEach(() => vi.clearAllMocks())

describe('connect — gated auth path selection', () => {
  it('password-capable provider + creds → ticket via passwordLogin', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([passwordProvider])

    await connect({ url: 'host:1', username: 'admin', password: 'pw' })

    expect(mockPasswordLogin).toHaveBeenCalledWith('http://host:1', 'admin', 'pw', 'basic')
    expect(mockOauthLogin).not.toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ mode: 'remote', authMode: 'ticket' })
  })

  it('oauth-only provider → interactive oauthLogin, no passwordLogin', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([oauthProvider])

    await connect({ url: 'gw.example.com' })

    expect(mockOauthStatus).toHaveBeenCalledWith('http://gw.example.com')
    expect(mockOauthLogin).toHaveBeenCalledWith('http://gw.example.com', 'nous')
    expect(mockPasswordLogin).not.toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ mode: 'remote', authMode: 'oauth' })
  })

  it('oauth with a still-live session → skips the interactive sign-in', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([oauthProvider])
    mockOauthStatus.mockResolvedValue({ signedIn: true })

    await connect({ url: 'gw.example.com' })

    expect(mockOauthLogin).not.toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ authMode: 'oauth' })
  })

  it('ungated backend with a token → token mode', async () => {
    status({ auth_required: false })

    await connect({ url: 'host:2', token: 'TOK' })

    expect(mockProviders).not.toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ mode: 'remote', authMode: 'token', token: 'TOK' })
  })
})

describe('connectLocal — desktop local spawn', () => {
  it('spawns a backend and connects in token mode', async () => {
    vi.mocked(spawnLocalBackend).mockResolvedValue({
      baseUrl: 'http://127.0.0.1:5051',
      token: 'LT',
      wsUrl: 'ws://127.0.0.1:5051/api/ws?token=LT'
    })

    await connectLocal()

    expect(spawnLocalBackend).toHaveBeenCalled()
    expect(vi.mocked(connectGateway)).toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ mode: 'local', authMode: 'token', token: 'LT' })
  })

  it('stops the child if the spawn/connect fails', async () => {
    vi.mocked(spawnLocalBackend).mockRejectedValue(new Error('hermes not found'))
    await expect(connectLocal()).rejects.toThrow('hermes not found')
    expect(stopLocalBackend).toHaveBeenCalled()
  })

  it('disconnect stops the local child when in local mode', async () => {
    vi.mocked(spawnLocalBackend).mockResolvedValue({ baseUrl: 'http://127.0.0.1:5051', token: 'LT', wsUrl: 'ws://x' })
    await connectLocal()
    vi.mocked(stopLocalBackend).mockClear()
    disconnect()
    expect(stopLocalBackend).toHaveBeenCalled()
  })
})

describe('connect — secure credential storage', () => {
  it('stores username in localStorage + secrets in the keyring, never plaintext', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([passwordProvider])

    await connect({ url: 'host:1', username: 'admin', password: 'pw' })

    expect(localStorage.getItem('hermes.username')).toBe('admin')
    expect(localStorage.getItem('hermes.url')).toBe('host:1')
    expect(localStorage.getItem('hermes.password')).toBeNull()
    expect(localStorage.getItem('hermes.token')).toBeNull()
    expect(saveSecrets).toHaveBeenCalledWith({ token: undefined, password: 'pw' })
  })

  it('loadSavedLogin returns the keyring secrets', async () => {
    expect(await loadSavedLogin()).toEqual({ token: 'T', password: 'P' })
  })
})
