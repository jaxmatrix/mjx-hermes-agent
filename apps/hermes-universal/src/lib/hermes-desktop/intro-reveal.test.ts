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

describe('introRevealBridge', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
    listen.mockResolvedValue(() => undefined)
    invoke.mockResolvedValue({ ok: true })
    vi.resetModules()
  })

  it('opens and closes with payloads', async () => {
    const { introRevealBridge } = await import('./intro-reveal')

    await expect(introRevealBridge.introReveal!.open({ hideMain: true })).resolves.toEqual({
      ok: true
    })
    expect(invoke).toHaveBeenCalledWith('intro_reveal_open', {
      payload: { hideMain: true }
    })

    await expect(introRevealBridge.introReveal!.close({ showMain: true })).resolves.toEqual({
      ok: true
    })
    expect(invoke).toHaveBeenCalledWith('intro_reveal_close', {
      payload: { showMain: true }
    })
  })

  it('fires skip over intro_reveal_skip', async () => {
    invoke.mockResolvedValue(undefined)

    const { introRevealBridge } = await import('./intro-reveal')
    introRevealBridge.introReveal!.skip()

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('intro_reveal_skip', {})
    })
  })

  it('fires ready over intro_reveal_ready', async () => {
    invoke.mockResolvedValue(undefined)

    const { introRevealBridge } = await import('./intro-reveal')
    introRevealBridge.introReveal!.ready()

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('intro_reveal_ready', {})
    })
  })

  it('forwards hermes://intro-reveal-skip', async () => {
    let handler: (() => void) | undefined
    listen.mockImplementation(async (_event: string, cb: () => void) => {
      handler = cb

      return () => undefined
    })

    const { introRevealBridge } = await import('./intro-reveal')
    const seen: string[] = []
    const off = introRevealBridge.introReveal!.onSkip(() => {
      seen.push('skip')
    })

    await vi.waitFor(() => expect(handler).toBeDefined())
    handler!()
    expect(seen).toEqual(['skip'])
    expect(listen).toHaveBeenCalledWith('hermes://intro-reveal-skip', expect.any(Function))
    off()
  })

  it('forwards hermes://intro-reveal-closed', async () => {
    let handler: (() => void) | undefined
    listen.mockImplementation(async (_event: string, cb: () => void) => {
      handler = cb

      return () => undefined
    })

    const { introRevealBridge } = await import('./intro-reveal')
    const seen: string[] = []
    const off = introRevealBridge.introReveal!.onClosed(() => {
      seen.push('closed')
    })

    await vi.waitFor(() => expect(handler).toBeDefined())
    handler!()
    expect(seen).toEqual(['closed'])
    expect(listen).toHaveBeenCalledWith('hermes://intro-reveal-closed', expect.any(Function))
    off()
  })
})
