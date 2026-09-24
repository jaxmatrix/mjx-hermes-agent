import { beforeEach, describe, expect, it, vi } from 'vitest'

const dir = vi.hoisted(() => ({ value: null as null | string }))
const open = vi.hoisted(() => vi.fn())

vi.mock('@/store/default-project-dir', () => ({
  $defaultProjectDir: { get: () => dir.value },
  setDefaultProjectDir: (next: null | string) => void (dir.value = next?.trim() || null)
}))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/home/me' }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }))

import { settingsBridge } from './settings'

const { settings } = settingsBridge

beforeEach(() => {
  vi.clearAllMocks()
  dir.value = null
})

describe('hermesDesktop.settings', () => {
  it('reads the preference, with the home folder as what "unset" means', async () => {
    expect(await settings.getDefaultProjectDir()).toEqual({
      defaultLabel: '/home/me',
      dir: null,
      resolvedCwd: '/home/me'
    })

    dir.value = '/work/app'

    expect(await settings.getDefaultProjectDir()).toEqual({
      defaultLabel: '/home/me',
      dir: '/work/app',
      resolvedCwd: '/work/app'
    })
  })

  it('sets and clears it through universal’s store', async () => {
    expect(await settings.setDefaultProjectDir(' /work/app ')).toEqual({ dir: '/work/app' })
    expect(await settings.setDefaultProjectDir(null)).toEqual({ dir: null })
  })

  it('picks a folder with the OS picker, starting from the current one', async () => {
    dir.value = '/work/app'
    open.mockResolvedValueOnce('/work/other')

    expect(await settings.pickDefaultProjectDir()).toEqual({ canceled: false, dir: '/work/other' })
    expect(open).toHaveBeenCalledExactlyOnceWith({ defaultPath: '/work/app', directory: true, multiple: false })

    open.mockResolvedValueOnce(null)

    expect(await settings.pickDefaultProjectDir()).toEqual({ canceled: true, dir: null })
  })
})
