import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][]
}))

const saveImageFrom = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])

    if (command === 'save_clipboard_image') {
      return ''
    }

    return `/tmp/${command}`
  })
}))

vi.mock('@/app/context-menu/actions', () => ({ saveImageFrom }))

import { imagesBridge } from './images'

beforeEach(() => {
  native.calls = []
  saveImageFrom.mockReset()
})

describe('hermesDesktop.saveImageFromUrl', () => {
  it('answers Electron’s boolean: written, or the dialog was dismissed', async () => {
    saveImageFrom.mockResolvedValueOnce('/home/me/a.png').mockResolvedValueOnce(null)

    await expect(imagesBridge.saveImageFromUrl('data:image/png;base64,AAAA')).resolves.toBe(true)
    await expect(imagesBridge.saveImageFromUrl('/tmp/a.png')).resolves.toBe(false)
    expect(saveImageFrom).toHaveBeenNthCalledWith(1, 'data:image/png;base64,AAAA')
  })

  it('rejects rather than saving nothing when the bytes cannot be read', async () => {
    saveImageFrom.mockRejectedValueOnce(new Error('unreadable'))

    await expect(imagesBridge.saveImageFromUrl('https://example.test/a.png')).rejects.toThrow('unreadable')
  })
})

describe('hermesDesktop.saveImageBuffer / savePastedText / saveClipboardImage', () => {
  it('base64-encodes the payload the renderer actually holds', async () => {
    await expect(imagesBridge.saveImageBuffer(new Uint8Array([65, 66, 67]), '.png', 'Screen Shot.png')).resolves.toBe(
      '/tmp/save_image_buffer'
    )

    expect(native.calls).toEqual([['save_image_buffer', { dataBase64: 'QUJD', ext: '.png', name: 'Screen Shot.png' }]])
  })

  it('forwards pasted text and clipboard reads to Rust', async () => {
    await expect(imagesBridge.savePastedText('hello')).resolves.toBe('/tmp/save_pasted_text')
    await expect(imagesBridge.saveClipboardImage()).resolves.toBe('')

    expect(native.calls).toEqual([
      ['save_pasted_text', { text: 'hello' }],
      ['save_clipboard_image', undefined]
    ])
  })
})
