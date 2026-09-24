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
  IS_TAURI: true
}))

describe('petOverlayBridge', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
    listen.mockResolvedValue(() => undefined)
    invoke.mockResolvedValue({ ok: true })
    vi.resetModules()
  })

  it('opens over Rust with request payload', async () => {
    invoke.mockResolvedValue({
      ok: true,
      bounds: { x: 1, y: 2, width: 240, height: 300 }
    })

    const { petOverlayBridge } = await import('./pet-overlay')

    await expect(
      petOverlayBridge.petOverlay!.open({
        bounds: { x: 10, y: 20, width: 240, height: 300 },
        screen: false
      })
    ).resolves.toMatchObject({ ok: true })

    expect(invoke).toHaveBeenCalledWith('pet_overlay_open', {
      request: { bounds: { x: 10, y: 20, width: 240, height: 300 }, screen: false }
    })
  })

  it('closes over Rust', async () => {
    const { petOverlayBridge } = await import('./pet-overlay')

    await expect(petOverlayBridge.petOverlay!.close()).resolves.toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledWith('pet_overlay_close', undefined)
  })

  it('setBounds invokes pet_overlay_set_bounds', async () => {
    const { petOverlayBridge } = await import('./pet-overlay')

    petOverlayBridge.petOverlay!.setBounds({ x: 0, y: 0, width: 100, height: 100 })

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('pet_overlay_set_bounds', {
        bounds: { x: 0, y: 0, width: 100, height: 100 }
      })
    })
  })

  it('setIgnoreMouse invokes pet_overlay_set_ignore_mouse', async () => {
    const { petOverlayBridge } = await import('./pet-overlay')

    petOverlayBridge.petOverlay!.setIgnoreMouse(true)

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('pet_overlay_set_ignore_mouse', { ignore: true })
    })
  })

  it('setFocusable invokes pet_overlay_set_focusable', async () => {
    const { petOverlayBridge } = await import('./pet-overlay')

    petOverlayBridge.petOverlay!.setFocusable(true)

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('pet_overlay_set_focusable', { focusable: true })
    })
  })

  it('subscribes to state events', async () => {
    const { petOverlayBridge } = await import('./pet-overlay')
    const off = petOverlayBridge.petOverlay!.onState(() => undefined)

    await vi.waitFor(() => {
      expect(listen).toHaveBeenCalledWith('hermes://pet-overlay-state', expect.any(Function))
    })

    off()
  })

  it('subscribes to control events', async () => {
    const { petOverlayBridge } = await import('./pet-overlay')
    const off = petOverlayBridge.petOverlay!.onControl(() => undefined)

    await vi.waitFor(() => {
      expect(listen).toHaveBeenCalledWith('hermes://pet-overlay-control', expect.any(Function))
    })

    off()
  })
})
