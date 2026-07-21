import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ mintWsTicket: vi.fn() }))

import { isGatewayReauthRequired } from '@/gateway'
import { mintWsTicket } from '@/lib/auth'
import type { AuthProvider } from '@/lib/auth'

import { authModeFromStatus, chooseGatedAuth, type Connection, modeIsRemoteLike, resolveWsUrl } from './gateway-config'

const provider = (name: string, supports_password: boolean): AuthProvider => ({
  name,
  display_name: name,
  supports_password
})

const mockMint = vi.mocked(mintWsTicket)

beforeEach(() => {
  mockMint.mockReset()
})

const conn = (over: Partial<Connection>): Connection => ({
  baseUrl: 'https://gw.example.com',
  authMode: 'none',
  ...over
})

describe('authModeFromStatus', () => {
  it('maps auth_required=true to oauth (interactive default)', () => {
    expect(authModeFromStatus({ auth_required: true })).toBe('oauth')
  })
  it('maps ungated backends to none', () => {
    expect(authModeFromStatus({ auth_required: false })).toBe('none')
    expect(authModeFromStatus({})).toBe('none')
  })
})

describe('modeIsRemoteLike', () => {
  it('treats cloud exactly like remote', () => {
    expect(modeIsRemoteLike('remote')).toBe(true)
    expect(modeIsRemoteLike('cloud')).toBe(true)
    expect(modeIsRemoteLike(undefined)).toBe(true)
    expect(modeIsRemoteLike('local')).toBe(false)
  })
})

describe('chooseGatedAuth', () => {
  it('uses password-login (ticket) only when creds are given AND a provider supports it', () => {
    const providers = [provider('basic', true), provider('nous', false)]
    expect(chooseGatedAuth(providers, true)).toEqual({ authMode: 'ticket', provider: 'basic' })
  })
  it('falls back to oauth when creds are given but no provider supports password', () => {
    expect(chooseGatedAuth([provider('nous', false)], true)).toEqual({ authMode: 'oauth', provider: 'nous' })
  })
  it('prefers a non-password provider for oauth', () => {
    const providers = [provider('basic', true), provider('nous', false)]
    expect(chooseGatedAuth(providers, false)).toEqual({ authMode: 'oauth', provider: 'nous' })
  })
  it('defaults the provider to nous when none advertised', () => {
    expect(chooseGatedAuth([], false)).toEqual({ authMode: 'oauth', provider: 'nous' })
  })
})

describe('resolveWsUrl', () => {
  it('none → ws URL with no auth param, no mint', async () => {
    const url = await resolveWsUrl(conn({ authMode: 'none' }))
    expect(url).toBe('wss://gw.example.com/api/ws')
    expect(mockMint).not.toHaveBeenCalled()
  })

  it('token → static ?token=', async () => {
    const url = await resolveWsUrl(conn({ authMode: 'token', token: 'T0' }))
    expect(url).toBe('wss://gw.example.com/api/ws?token=T0')
    expect(mockMint).not.toHaveBeenCalled()
  })

  it('ticket → freshly minted ?ticket=', async () => {
    mockMint.mockResolvedValue('TIX')
    const url = await resolveWsUrl(conn({ authMode: 'ticket' }))
    expect(url).toBe('wss://gw.example.com/api/ws?ticket=TIX')
    expect(mockMint).toHaveBeenCalledWith('https://gw.example.com')
  })

  it('oauth → freshly minted ?ticket= (same mint as ticket)', async () => {
    mockMint.mockResolvedValue('OATIX')
    const url = await resolveWsUrl(conn({ authMode: 'oauth', profile: 'p1' }))
    expect(url).toBe('wss://gw.example.com/api/ws?ticket=OATIX')
    expect(mockMint).toHaveBeenCalledWith('https://gw.example.com')
  })

  it('oauth mint failure → GatewayReauthRequiredError (re-open sign-in)', async () => {
    mockMint.mockRejectedValue(new Error('401'))
    await expect(resolveWsUrl(conn({ authMode: 'oauth' }))).rejects.toSatisfy(isGatewayReauthRequired)
  })

  it('ticket mint failure → propagates (no ticketless fallback)', async () => {
    mockMint.mockRejectedValue(new Error('boom'))
    await expect(resolveWsUrl(conn({ authMode: 'ticket' }))).rejects.toThrow('boom')
  })

  it('derives ws:// for http backends', async () => {
    const url = await resolveWsUrl(conn({ baseUrl: 'http://127.0.0.1:8080', authMode: 'none' }))
    expect(url).toBe('ws://127.0.0.1:8080/api/ws')
  })
})
