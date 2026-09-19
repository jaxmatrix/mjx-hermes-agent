import { beforeEach, describe, expect, it, vi } from 'vitest'

const setTheme = vi.hoisted(() => vi.fn(async (_theme: null | string) => {}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme }) }))

import { nativeThemeBridge as bridge } from './native-theme'

beforeEach(() => vi.clearAllMocks())

describe('setNativeTheme', () => {
  it.each([
    ['dark', 'dark'],
    ['light', 'light'],
    ['system', null]
  ] as const)('pins the window to %s', async (mode, theme) => {
    expect(bridge.setNativeTheme(mode)).toBeUndefined()

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledExactlyOnceWith(theme))
  })

  it('treats a refusal as cosmetic', async () => {
    setTheme.mockRejectedValueOnce(new Error('window.set_theme not allowed'))

    expect(() => bridge.setNativeTheme('dark')).not.toThrow()
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledOnce())
  })
})
