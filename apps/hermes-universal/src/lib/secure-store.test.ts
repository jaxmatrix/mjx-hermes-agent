import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/platform', () => ({ IS_TAURI: true }))

import { invoke } from '@tauri-apps/api/core'

import { clearSecrets, loadSecrets, saveSecrets, secureStoreAvailable } from './secure-store'

const mockInvoke = vi.mocked(invoke)

// Route the vendored plugin:keyring|* commands. Default: init + writes resolve,
// nothing stored. Tests override per case.
type Impl = (cmd: string, args: { username?: string }) => Promise<unknown>
const setImpl = (fn: Impl) => mockInvoke.mockImplementation(fn as never)

const base: Impl = cmd => (cmd === 'plugin:keyring|has_password' ? Promise.resolve(false) : Promise.resolve())

beforeEach(() => {
  mockInvoke.mockReset()
  setImpl(base)
})

describe('secure-store (keystore)', () => {
  it('saveSecrets writes token + password by username', async () => {
    const ok = await saveSecrets({ token: 'T', password: 'P' })
    expect(ok).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('plugin:keyring|set_password', { username: 'token', password: 'T' })
    expect(mockInvoke).toHaveBeenCalledWith('plugin:keyring|set_password', { username: 'password', password: 'P' })
  })

  it('saveSecrets deletes an empty field instead of writing it', async () => {
    await saveSecrets({ token: 'T' })
    expect(mockInvoke).toHaveBeenCalledWith('plugin:keyring|set_password', { username: 'token', password: 'T' })
    expect(mockInvoke).toHaveBeenCalledWith('plugin:keyring|delete_password', { username: 'password' })
  })

  it('loadSecrets reads back the entries; null when both empty', async () => {
    setImpl((cmd, args) => {
      if (cmd === 'plugin:keyring|has_password') return Promise.resolve(true)
      if (cmd === 'plugin:keyring|get_password') return Promise.resolve(args.username === 'token' ? 'T' : 'P')
      return Promise.resolve()
    })
    expect(await loadSecrets()).toEqual({ token: 'T', password: 'P' })

    setImpl(base) // has_password → false, so both absent
    expect(await loadSecrets()).toBeNull()
  })

  it('returns false/null (no throw) when the keystore rejects', async () => {
    setImpl(cmd => (cmd === 'plugin:keyring|initialize_keyring' ? Promise.resolve() : Promise.reject(new Error('no keystore'))))
    expect(await saveSecrets({ token: 'T' })).toBe(false)
    expect(await loadSecrets()).toBeNull()
  })

  it('secureStoreAvailable true when a probe read resolves', async () => {
    expect(await secureStoreAvailable()).toBe(true)
  })

  it('clearSecrets removes both entries', async () => {
    await clearSecrets()
    expect(mockInvoke).toHaveBeenCalledWith('plugin:keyring|delete_password', { username: 'token' })
    expect(mockInvoke).toHaveBeenCalledWith('plugin:keyring|delete_password', { username: 'password' })
  })
})
