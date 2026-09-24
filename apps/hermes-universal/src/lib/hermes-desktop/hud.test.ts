import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const listen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args)
}))

vi.mock('@/lib/platform', () => ({
  IS_DESKTOP: true,
  IS_TAURI: true,
  PLATFORM: 'linux'
}))

const openSatelliteWindow = vi.fn()
const closeSatelliteWindow = vi.fn()
const doesSatelliteWindowExist = vi.fn()

vi.mock('@/store/windows', () => ({
  HUD_SURFACE: 'hud',
  openSatelliteWindow: (...args: unknown[]) => openSatelliteWindow(...args),
  closeSatelliteWindow: (...args: unknown[]) => closeSatelliteWindow(...args),
  doesSatelliteWindowExist: (...args: unknown[]) => doesSatelliteWindowExist(...args)
}))

vi.mock('@/app/routes', () => ({
  sessionRoute: (id: string) => `/${id}`
}))

vi.mock('@/store/translucency', () => ({
  $translucency: {
    get: () => ({
      mode: 'glass',
      intensity: 40,
      fade: 0,
      material: 'popover',
      scope: 'window'
    })
  }
}))

vi.mock('@/lib/translucency-model', () => ({
  glassActive: () => true
}))

describe('hudBridge', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
    listen.mockResolvedValue(() => undefined)
    invoke.mockResolvedValue({ ok: true })
    openSatelliteWindow.mockReset()
    closeSatelliteWindow.mockReset()
    doesSatelliteWindowExist.mockReset()
    openSatelliteWindow.mockResolvedValue('sat-hud')
    closeSatelliteWindow.mockResolvedValue(undefined)
    doesSatelliteWindowExist.mockResolvedValue(false)
    vi.resetModules()
  })

  it('opens over openSatelliteWindow with session route + profile', async () => {
    const { hudBridge } = await import('./hud')

    await expect(hudBridge.hud!.open({ sessionId: 'sess-1', profile: 'work' })).resolves.toEqual({ ok: true })

    expect(openSatelliteWindow).toHaveBeenCalledWith('hud', '/sess-1', 'work')
    expect(invoke).toHaveBeenCalledWith('hud_set_session', { sessionId: 'sess-1' })
    expect(invoke).toHaveBeenCalledWith('hud_broadcast_changed', { open: true })
  })

  it('emits goto when the HUD was already up', async () => {
    doesSatelliteWindowExist.mockResolvedValue(true)

    const { hudBridge } = await import('./hud')

    await hudBridge.hud!.open({ sessionId: 'other' })

    expect(invoke).toHaveBeenCalledWith('hud_emit_goto', { sessionId: 'other' })
  })

  it('closes over closeSatelliteWindow', async () => {
    const { hudBridge } = await import('./hud')

    await expect(hudBridge.hud!.close()).resolves.toEqual({ ok: true })
    expect(closeSatelliteWindow).toHaveBeenCalledWith('hud')
    expect(invoke).toHaveBeenCalledWith('hud_broadcast_changed', { open: false })
  })

  it('setIgnoreMouse invokes hud_set_ignore_mouse', async () => {
    const { hudBridge } = await import('./hud')

    hudBridge.hud!.setIgnoreMouse(true)

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('hud_set_ignore_mouse', { ignore: true })
    })
  })

  it('setBounds invokes hud_set_bounds', async () => {
    const { hudBridge } = await import('./hud')

    hudBridge.hud!.setBounds({ x: 1, y: 2, width: 600, height: 80 })

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('hud_set_bounds', {
        bounds: { x: 1, y: 2, width: 600, height: 80 }
      })
    })
  })

  it('setFrost applies appearance_set_glass on the HUD webview', async () => {
    const { hudBridge } = await import('./hud')

    await expect(hudBridge.hud!.setFrost(true)).resolves.toEqual({ ok: true })

    expect(invoke).toHaveBeenCalledWith('appearance_set_glass', {
      state: { mode: 'glass', intensity: 40, fade: 0, material: 'popover' }
    })
  })

  it('subscribes to hud-changed and satellite-closed', async () => {
    const { hudBridge } = await import('./hud')
    const off = hudBridge.hud!.onChanged(() => undefined)

    await vi.waitFor(() => {
      expect(listen).toHaveBeenCalledWith('hermes://hud-changed', expect.any(Function))
      expect(listen).toHaveBeenCalledWith('hermes://satellite-window-closed', expect.any(Function))
    })

    off()
  })

  it('exposes windowing + nativeDrag', async () => {
    const { hudBridge } = await import('./hud')

    expect(hudBridge.hud!.windowing).toMatchObject({
      clientPlacement: expect.any(Boolean),
      controlDrag: expect.any(Boolean),
      nativeDrag: expect.any(Boolean),
      solid: expect.any(Boolean),
      workspaceTransfer: expect.any(Boolean)
    })
    expect(typeof hudBridge.hud!.nativeDrag).toBe('boolean')
  })
})
