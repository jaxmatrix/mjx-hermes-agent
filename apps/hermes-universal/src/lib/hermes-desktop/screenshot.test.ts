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

describe('screenshotBridge', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
    listen.mockResolvedValue(() => undefined)
    invoke.mockResolvedValue({ enabled: false, state: 'unavailable' })
    vi.resetModules()
  })

  it('wires settings + capture commands', async () => {
    const { screenshotBridge } = await import('./screenshot')
    const api = screenshotBridge.screenshot!

    await api.getSettings()
    expect(invoke).toHaveBeenCalledWith('screenshot_settings_get', undefined)

    await api.setEnabled(true)
    expect(invoke).toHaveBeenCalledWith('screenshot_settings_set', { enabled: true })

    invoke.mockResolvedValueOnce({ ok: false, reason: 'expired' })
    await expect(api.capture('req-1')).resolves.toEqual({ ok: false, reason: 'expired' })
    expect(invoke).toHaveBeenCalledWith('screenshot_capture', { requestId: 'req-1' })
  })

  it('onRequest subscribes and listens', async () => {
    const { screenshotBridge } = await import('./screenshot')
    const stop = screenshotBridge.screenshot!.onRequest(() => undefined)

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('screenshot_subscribe', { subscribed: true }))
    expect(listen.mock.calls.some(c => c[0] === 'hermes://screenshot-request')).toBe(true)

    stop()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('screenshot_subscribe', { subscribed: false }))
  })
})
