import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: vi.fn().mockResolvedValue({}) }))

import { api } from '@/lib/api'

import { getHermesConfig, getSession, getStatus, saveHermesConfig } from './hermes'

const mockApi = vi.mocked(api)

afterEach(() => mockApi.mockClear())

// Light coverage that the whole-file port kept each function wired to the right
// request through the mobile api() seam.
describe('hermes REST client', () => {
  it('getStatus → GET /api/status', async () => {
    await getStatus()
    expect(mockApi).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/status' }))
  })

  it('getSession(id) → /api/sessions/{id}', async () => {
    await getSession('abc')
    expect(mockApi).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('/api/sessions/abc') })
    )
  })

  it('getHermesConfig → /api/config', async () => {
    await getHermesConfig()
    expect(mockApi).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/config' }))
  })

  it('saveHermesConfig → PUT /api/config with a body', async () => {
    await saveHermesConfig({ x: 1 })
    expect(mockApi).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/config', method: 'PUT' }))
  })
})
