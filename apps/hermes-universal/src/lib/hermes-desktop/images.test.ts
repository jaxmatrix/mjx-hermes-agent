import { describe, expect, it, vi } from 'vitest'

const saveImageFrom = vi.hoisted(() => vi.fn())

vi.mock('@/app/context-menu/actions', () => ({ saveImageFrom }))

import { imagesBridge } from './images'

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
