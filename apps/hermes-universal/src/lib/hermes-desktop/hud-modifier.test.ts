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

describe('hudModifierBridge', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
    listen.mockResolvedValue(() => undefined)
    invoke.mockResolvedValue({
      enabled: false,
      state: 'disabled'
    })
    vi.resetModules()
  })

  it('getSettings / setEnabled / openPermissionSettings hit Rust cmds', async () => {
    const { hudModifierBridge } = await import('./hud-modifier')
    const api = hudModifierBridge.hudModifier!

    await expect(api.getSettings()).resolves.toEqual({ enabled: false, state: 'disabled' })
    expect(invoke).toHaveBeenCalledWith('hud_modifier_settings_get', undefined)

    invoke.mockResolvedValueOnce({ enabled: true, state: 'starting' })
    await expect(api.setEnabled(true)).resolves.toEqual({ enabled: true, state: 'starting' })
    expect(invoke).toHaveBeenCalledWith('hud_modifier_settings_set', { enabled: true })

    await api.openPermissionSettings()
    expect(invoke).toHaveBeenCalledWith('hud_modifier_open_permission', undefined)
  })

  it('onStatus listens on the status event', async () => {
    const { hudModifierBridge } = await import('./hud-modifier')
    const cb = vi.fn()

    hudModifierBridge.hudModifier!.onStatus(cb)
    await vi.waitFor(() => expect(listen).toHaveBeenCalled())

    expect(listen.mock.calls[0]?.[0]).toBe('hermes://hud-modifier-status')
  })
})
