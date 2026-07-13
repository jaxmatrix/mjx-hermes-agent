import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('tauri-plugin-keyring-api', () => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn()
}))
vi.mock('@/lib/platform', () => ({ IS_MOBILE: true }))

import { deletePassword, getPassword, setPassword } from 'tauri-plugin-keyring-api'

import { clearSecrets, loadSecrets, saveSecrets, secureStoreAvailable } from './secure-store'

const mockGet = vi.mocked(getPassword)
const mockSet = vi.mocked(setPassword)
const mockDel = vi.mocked(deletePassword)

afterEach(() => vi.clearAllMocks())

describe('secure-store (keyring)', () => {
  it('saveSecrets writes token + password under the service', async () => {
    mockSet.mockResolvedValue(undefined)
    const ok = await saveSecrets({ token: 'T', password: 'P' })
    expect(ok).toBe(true)
    expect(mockSet).toHaveBeenCalledWith('hermes-mobile', 'token', 'T')
    expect(mockSet).toHaveBeenCalledWith('hermes-mobile', 'password', 'P')
  })

  it('saveSecrets deletes an empty field instead of writing it', async () => {
    mockSet.mockResolvedValue(undefined)
    mockDel.mockResolvedValue(undefined)
    await saveSecrets({ token: 'T' })
    expect(mockSet).toHaveBeenCalledWith('hermes-mobile', 'token', 'T')
    expect(mockDel).toHaveBeenCalledWith('hermes-mobile', 'password')
  })

  it('loadSecrets reads back the entries; null when both empty', async () => {
    mockGet.mockResolvedValueOnce('T').mockResolvedValueOnce('P')
    expect(await loadSecrets()).toEqual({ token: 'T', password: 'P' })
    mockGet.mockResolvedValue(null)
    expect(await loadSecrets()).toBeNull()
  })

  it('returns false/null (no throw) when the keyring rejects', async () => {
    mockSet.mockRejectedValue(new Error('no keyring'))
    mockGet.mockRejectedValue(new Error('no keyring'))
    expect(await saveSecrets({ token: 'T' })).toBe(false)
    expect(await loadSecrets()).toBeNull()
  })

  it('secureStoreAvailable true when a probe read resolves', async () => {
    mockGet.mockResolvedValue(null)
    expect(await secureStoreAvailable()).toBe(true)
  })

  it('clearSecrets removes both entries', async () => {
    mockDel.mockResolvedValue(undefined)
    await clearSecrets()
    expect(mockDel).toHaveBeenCalledWith('hermes-mobile', 'token')
    expect(mockDel).toHaveBeenCalledWith('hermes-mobile', 'password')
  })
})
