import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))

import { $connection } from '@/store/connection'
import { httpRequest } from '@/transport/http'

import { api } from './api'

const mockHttp = vi.mocked(httpRequest)

afterEach(() => {
  mockHttp.mockReset()
  $connection.set(null)
})

describe('api', () => {
  it('throws when not connected', async () => {
    await expect(api({ path: '/api/status' })).rejects.toThrow('Not connected')
  })

  it('joins base+path, attaches the session token, parses JSON', async () => {
    $connection.set({ baseUrl: 'http://host:1', authMode: 'token', token: 'TOK' })
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify({ ok: true }) })

    const res = await api<{ ok: boolean }>({ path: '/api/status' })

    expect(res).toEqual({ ok: true })
    expect(mockHttp).toHaveBeenCalledWith(
      'GET',
      'http://host:1/api/status',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Hermes-Session-Token': 'TOK' }) })
    )
  })

  it('sets Content-Type on a body and throws on a non-2xx status', async () => {
    $connection.set({ baseUrl: 'http://host:1', authMode: 'none' })
    mockHttp.mockResolvedValue({ status: 500, headers: {}, body: 'boom' })

    await expect(api({ path: '/x', method: 'POST', body: { a: 1 } })).rejects.toThrow('HTTP 500')
    expect(mockHttp).toHaveBeenCalledWith(
      'POST',
      'http://host:1/x',
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/json' }) })
    )
  })
})
