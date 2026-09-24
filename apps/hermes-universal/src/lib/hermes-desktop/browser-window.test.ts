import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const listen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args)
}))

describe('browserWindowBridge', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
    vi.resetModules()
  })

  it('opens a Browser pop-out by tab id', async () => {
    invoke.mockResolvedValue(undefined)

    const { browserWindowBridge } = await import('./browser-window')
    const result = await browserWindowBridge.openBrowserWindow('url:browser-1')

    expect(result).toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledWith('open_browser_window', { tabId: 'url:browser-1' })
  })

  it('refuses a blank tab id without IPC', async () => {
    const { browserWindowBridge } = await import('./browser-window')

    await expect(browserWindowBridge.openBrowserWindow('  ')).resolves.toEqual({
      ok: false,
      error: 'invalid-tab-id'
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('surfaces a Rust refusal as { ok: false }', async () => {
    invoke.mockRejectedValue(new Error('unsupported tab id'))

    const { browserWindowBridge } = await import('./browser-window')

    await expect(browserWindowBridge.openBrowserWindow('bad?id')).resolves.toEqual({
      ok: false,
      error: 'unsupported tab id'
    })
  })

  it('forwards hermes://browser-window-closed payloads', async () => {
    let handler: ((event: { payload: string }) => void) | undefined
    listen.mockImplementation(async (_event: string, cb: (event: { payload: string }) => void) => {
      handler = cb

      return () => undefined
    })

    const { browserWindowBridge } = await import('./browser-window')
    const seen: string[] = []

    const off = browserWindowBridge.onBrowserPopoutClosed(tabId => {
      seen.push(tabId)
    })

    await vi.waitFor(() => expect(handler).toBeDefined())
    handler!({ payload: 'url:browser-1' })
    handler!({ payload: '  ' })

    expect(seen).toEqual(['url:browser-1'])
    off()
  })
})
