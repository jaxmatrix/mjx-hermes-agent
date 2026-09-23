import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown>][],
  read: (() => 'QUJD') as () => string
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    native.calls.push([command, args])

    if (command === 'set_data_url_read_max') {
      return Math.min(4096, Math.max(1, Math.round(Number(args.maxMb))))
    }

    return native.read()
  })
}))
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home/me',
  join: async (...parts: string[]) => parts.join('').replace(/\/+/g, '/')
}))
vi.mock('@/lib/media', () => ({
  mediaMime: (path: string) => (path.endsWith('.png') ? 'image/png' : 'application/octet-stream')
}))

import { __resetDataUrlReadMax, filesBridge } from './files'
import { sensitivePathBlockReason } from './sensitive-path'

const KEY = 'hermes.dataUrlReadMaxMb'

beforeEach(() => {
  native.calls = []
  native.read = () => 'QUJD'
  window.localStorage.clear()
  __resetDataUrlReadMax()
})

describe('hermesDesktop.dataUrlReadMax', () => {
  it('is the whole namespace desktop calls', () => {
    expect(Object.keys(filesBridge.dataUrlReadMax!).sort()).toEqual(['get', 'set'])
  })

  it('get pushes the persisted cap down once and answers Electron’s shape', async () => {
    window.localStorage.setItem(KEY, '2')

    await expect(filesBridge.dataUrlReadMax!.get()).resolves.toEqual({
      defaultMaxMb: 16,
      maxBytes: 2 * 1024 * 1024,
      maxMb: 2
    })
    await filesBridge.dataUrlReadMax!.get()

    expect(native.calls).toEqual([['set_data_url_read_max', { maxMb: 2 }]])
  })

  it('set persists what Rust stored, not what was asked', async () => {
    await expect(filesBridge.dataUrlReadMax!.set(9000)).resolves.toMatchObject({ maxMb: 4096 })

    expect(window.localStorage.getItem(KEY)).toBe('4096')
  })
})

describe('hermesDesktop.readFileDataUrl', () => {
  it('puts the cap in force, then reads through Rust and names the MIME', async () => {
    window.localStorage.setItem(KEY, '4')

    await expect(filesBridge.readFileDataUrl('/tmp/shot.png')).resolves.toBe('data:image/png;base64,QUJD')

    expect(native.calls).toEqual([
      ['set_data_url_read_max', { maxMb: 4 }],
      ['read_capped_file_base64', { path: '/tmp/shot.png' }]
    ])
  })

  it('reads what a renderer actually sends: a file URL, a home path, a content URI', async () => {
    await filesBridge.readFileDataUrl('file:///tmp/a%20b.png')
    await filesBridge.readFileDataUrl('~/pics/c.png')
    await filesBridge.readFileDataUrl('content://media/external/images/7')

    expect(
      native.calls.filter(([command]) => command === 'read_capped_file_base64').map(([, args]) => args.path)
    ).toEqual(['/tmp/a b.png', '/home/me/pics/c.png', 'content://media/external/images/7'])
  })

  it('keeps the size refusal desktop parses, and no path in any other', async () => {
    native.read = () => {
      throw { message: 'file is too large (99 bytes; limit 10 bytes)', tooLarge: true }
    }

    await expect(filesBridge.readFileDataUrl('/tmp/big.bin')).rejects.toThrow(/too large .*limit 10 bytes/)

    native.read = () => {
      throw { message: 'No such file: /home/me/secret-name.txt', tooLarge: false }
    }

    const error = (await filesBridge.readFileDataUrl('/home/me/secret-name.txt').catch(e => e)) as Error

    expect(error.message).toBe('File preview failed: file is not readable.')
  })

  it('refuses a credential file before Rust is asked', async () => {
    for (const path of [
      '/home/me/.ssh/config',
      '/work/app/.env',
      '/home/me/id_ed25519',
      '/x/cert.pem',
      '/home/me/.netrc'
    ]) {
      await expect(filesBridge.readFileDataUrl(path)).rejects.toThrow(/blocked/)
    }

    expect(native.calls).toEqual([])
    expect(sensitivePathBlockReason('/work/app/.env.example')).toBeNull()
    expect(sensitivePathBlockReason('/home/me/id_ed25519.pub')).toBeNull()
    expect(sensitivePathBlockReason('C:\\Users\\me\\.aws\\credentials')).toMatch(/AWS/)
  })

  it('leaves the attach-sized read absent, so its caller falls back to this one', () => {
    expect(filesBridge).not.toHaveProperty('readFileDataUrlForAttach')
  })
})
