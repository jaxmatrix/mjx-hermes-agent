import { beforeEach, describe, expect, it, vi } from 'vitest'

const win = vi.hoisted(() => ({
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  setFocus: vi.fn(async () => {}),
  close: vi.fn(async () => {})
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }))

vi.mock('@/lib/platform', () => ({ IS_DESKTOP: true, IS_TAURI: true, IS_MAC: false }))

import { windowControlsBridge } from './window-controls'

beforeEach(() => {
  win.minimize.mockClear()
  win.toggleMaximize.mockClear()
  win.setFocus.mockClear()
  win.close.mockClear()
})

describe('hermesDesktop.windowControls', () => {
  it('exposes Electron’s shape with custom false (WindowChrome owns buttons)', () => {
    expect(windowControlsBridge.windowControls).toMatchObject({
      custom: false,
      minimize: expect.any(Function),
      toggleMaximize: expect.any(Function),
      close: expect.any(Function)
    })
  })

  it('minimize / toggleMaximize / close drive the current Tauri window', async () => {
    windowControlsBridge.windowControls!.minimize()
    windowControlsBridge.windowControls!.toggleMaximize()
    windowControlsBridge.windowControls!.close()

    await vi.waitFor(() => {
      expect(win.minimize).toHaveBeenCalledOnce()
      expect(win.toggleMaximize).toHaveBeenCalledOnce()
      expect(win.setFocus).toHaveBeenCalledOnce()
      expect(win.close).toHaveBeenCalledOnce()
    })
  })
})
