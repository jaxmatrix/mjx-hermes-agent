import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown>][],
  fail: new Set<string>(),
  mode: 'local' as 'local' | 'remote',
  platform: 'linux'
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    native.calls.push([command, args])

    if (native.fail.has(command)) {
      throw new Error(`refused ${JSON.stringify(args)}`)
    }

    return command === 'fetch_link_title' ? 'A title' : undefined
  })
}))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => native.platform }))
vi.mock('@/store/session', () => ({ $connection: { get: () => ({ mode: native.mode }) } }))

async function bridge() {
  vi.resetModules()

  return import('./external')
}

beforeEach(() => {
  native.calls = []
  native.fail.clear()
  native.mode = 'local'
  native.platform = 'linux'
})

describe('hermesDesktop.openExternal', () => {
  it('hands http, https and mailto to Rust’s opener, normalized', async () => {
    const { externalBridge } = await bridge()

    await externalBridge.openExternal(' https://example.test/a b ')
    await externalBridge.openExternal('mailto:someone@example.test')

    expect(native.calls).toEqual([
      ['open_external', { url: 'https://example.test/a%20b' }],
      ['open_external', { url: 'mailto:someone@example.test' }]
    ])
  })

  it('refuses every other scheme with Electron’s error, and never reaches Rust', async () => {
    const { externalBridge } = await bridge()

    for (const url of ['javascript:alert(1)', 'vscode://file/etc/passwd', 'hermes://mcp/install', 'not a url', '']) {
      await expect(externalBridge.openExternal(url)).rejects.toThrow('Invalid external URL')
    }

    expect(native.calls).toEqual([])
  })

  it('opens a file URL only where the backend is this machine', async () => {
    const { externalBridge } = await bridge()

    await externalBridge.openExternal('file:///home/me/report%20final.html')
    expect(native.calls).toEqual([['open_external', { url: 'file:///home/me/report%20final.html' }]])

    native.calls = []
    native.mode = 'remote'

    await expect(externalBridge.openExternal('file:///home/me/report.html')).rejects.toThrow(/on the gateway/)
    expect(native.calls).toEqual([])
  })

  it('never opens a file URL on a phone, whatever the connection says', async () => {
    native.platform = 'android'

    const { externalBridge } = await bridge()

    await expect(externalBridge.openExternal('file:///sdcard/a.html')).rejects.toThrow(/on the gateway/)
    expect(native.calls).toEqual([])
  })

  it('reveals a file the OS has no handler for, as Electron does', async () => {
    native.fail.add('open_external')

    const { externalBridge } = await bridge()

    await externalBridge.openExternal('file:///home/me/data.xyz')

    expect(native.calls.at(-1)).toEqual(['reveal_in_file_manager', { path: '/home/me/data.xyz' }])
  })

  it('keeps the URL out of the error when the OS refuses', async () => {
    native.fail.add('open_external')

    const { externalBridge } = await bridge()
    const error = await externalBridge.openExternal('https://secret.example.test/?token=abc').catch(e => e as Error)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toMatch(/secret|token/)
  })
})

describe('hermesDesktop.revealPath / fetchLinkTitle', () => {
  it('answers whether the file manager took it', async () => {
    const { revealBridge } = await bridge()

    await expect(revealBridge.revealPath!('/home/me/a.txt')).resolves.toBe(true)
    await expect(revealBridge.revealPath!('  ')).resolves.toBe(false)

    native.fail.add('reveal_in_file_manager')
    await expect(revealBridge.revealPath!('/home/me/a.txt')).resolves.toBe(false)
  })

  it('reads a title through Rust', async () => {
    const { externalBridge } = await bridge()

    await expect(externalBridge.fetchLinkTitle('https://example.test')).resolves.toBe('A title')
    expect(native.calls).toEqual([['fetch_link_title', { url: 'https://example.test' }]])
  })
})
