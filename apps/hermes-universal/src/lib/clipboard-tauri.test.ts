import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { pluginReadText, pluginWriteText } = vi.hoisted(() => ({
  pluginReadText: vi.fn(),
  pluginWriteText: vi.fn()
}))

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: pluginReadText,
  writeText: pluginWriteText
}))

import { createClipboardBridge, readClipboardText } from './clipboard-tauri'

// A stand-in for the webview's own async Clipboard API. jsdom does not ship one,
// so every case has to install exactly the shape it is testing — which is the
// point: "WebKitGTK has no usable `readText`" is a real target state, not a
// hypothetical, and the fallback has to be correct for it.
function installWebClipboard(api: Partial<Clipboard> | undefined) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: api, writable: true })
}

beforeEach(() => {
  pluginReadText.mockReset()
  pluginWriteText.mockReset()
  installWebClipboard(undefined)
})

afterEach(() => vi.restoreAllMocks())

describe('the bridge writeClipboard', () => {
  it('writes through the OS plugin and does NOT touch the web API', async () => {
    const webWrite = vi.fn(async () => {})
    installWebClipboard({ writeText: webWrite } as unknown as Clipboard)
    pluginWriteText.mockResolvedValue(undefined)

    await expect(createClipboardBridge().writeClipboard('hello')).resolves.toBe(true)

    expect(pluginWriteText).toHaveBeenCalledWith('hello')
    expect(webWrite).not.toHaveBeenCalled()
  })

  // The plugin call lives INSIDE the try for a reason: in a plain browser the
  // module imports fine and only `invoke` rejects, so guarding the import alone
  // would let the rejection escape instead of falling back.
  it('falls back to the web API when the plugin rejects', async () => {
    const webWrite = vi.fn(async () => {})
    installWebClipboard({ writeText: webWrite } as unknown as Clipboard)
    pluginWriteText.mockRejectedValue(new Error('clipboard-manager.write_text not allowed'))

    await createClipboardBridge().writeClipboard('hello')

    expect(webWrite).toHaveBeenCalledWith('hello')
  })

  it('throws when neither path exists, so a copy button can show its error state', async () => {
    pluginWriteText.mockRejectedValue(new Error('no plugin'))

    await expect(createClipboardBridge().writeClipboard('hello')).rejects.toThrow(/unavailable/i)
  })

  // Desktop's `installClipboardShim` replaces `navigator.clipboard.writeText`
  // with a function that calls this bridge member. Falling back through the live
  // property would recurse forever whenever the plugin refuses.
  it('falls back to the webview writeText captured BEFORE desktop shims it', async () => {
    const webWrite = vi.fn(async () => {})
    installWebClipboard({ writeText: webWrite } as unknown as Clipboard)
    pluginWriteText.mockRejectedValue(new Error('no plugin'))

    const bridge = createClipboardBridge()
    const shimmed = vi.fn((text: string) => bridge.writeClipboard(text).then(() => undefined))
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: shimmed, writable: true })

    await bridge.writeClipboard('hello')

    expect(webWrite).toHaveBeenCalledWith('hello')
    expect(shimmed).not.toHaveBeenCalled()
  })
})

describe('readClipboardText', () => {
  it('reads through the OS plugin and does NOT touch the web API', async () => {
    const webRead = vi.fn(async () => 'from-webview')
    installWebClipboard({ readText: webRead } as unknown as Clipboard)
    pluginReadText.mockResolvedValue('from-os')

    await expect(readClipboardText()).resolves.toBe('from-os')
    expect(webRead).not.toHaveBeenCalled()
  })

  it('falls back to the web API when the plugin rejects', async () => {
    installWebClipboard({ readText: vi.fn(async () => 'from-webview') } as unknown as Clipboard)
    pluginReadText.mockRejectedValue(new Error('no plugin'))

    await expect(readClipboardText()).resolves.toBe('from-webview')
  })

  // A paste the platform refuses must be a no-op over a shell prompt, never a
  // thrown error — the terminal's chord handler has nowhere to put one.
  it('answers empty rather than throwing when both refuse', async () => {
    installWebClipboard({ readText: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) } as never)
    pluginReadText.mockRejectedValue(new Error('no plugin'))

    await expect(readClipboardText()).resolves.toBe('')
  })

  it('answers empty when the webview has no clipboard object at all', async () => {
    pluginReadText.mockRejectedValue(new Error('no plugin'))

    await expect(readClipboardText()).resolves.toBe('')
  })
})

/**
 * The OS path only works if every door leads to it.
 *
 * MJXHRM-415 installed the clipboard plugin and wired two call sites — and four
 * others went on calling `navigator.clipboard` directly, so on WebKitGTK each
 * silently did nothing. Desktop's tree calls `navigator.clipboard.writeText`
 * freely and relies on `installClipboardShim` (`lib/clipboard.ts`) to route it
 * through `window.hermesDesktop.writeClipboard` — so WRITES are covered exactly
 * when the bridge carries that member. READS have no shim: a direct `readText` /
 * `read` is dead on WebKitGTK, and a grep is the only assertion that catches one.
 */
describe('every door leads to the OS clipboard', () => {
  const SRC = path.join(process.cwd(), 'src')
  const DIRECT_READ = /navigator\s*\.\s*clipboard\s*\??\s*\.\s*(readText|read)\b/

  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        return sources(full)
      }

      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : []
    })
  }

  it('installs both bridge members, so desktop’s writeText shim and copy button engage', async () => {
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
    Reflect.deleteProperty(window, 'hermesDesktop')

    const { installHermesDesktopBridge } = await import('@/lib/hermes-desktop')

    installHermesDesktopBridge()

    expect(typeof window.hermesDesktop?.writeClipboard).toBe('function')
    expect(typeof window.hermesDesktop?.readClipboard).toBe('function')
  })

  it('finds no direct navigator.clipboard read outside lib/clipboard-tauri.ts', () => {
    const seam = path.join(SRC, 'lib', 'clipboard-tauri.ts')

    const offenders = sources(SRC)
      .filter(file => file !== seam)
      .filter(file => DIRECT_READ.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(SRC, file))

    expect(offenders).toEqual([])
  })

  it('scans a believable number of files (so an empty walk cannot pass it)', () => {
    expect(sources(SRC).length).toBeGreaterThan(300)
  })
})
