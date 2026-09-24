import { describe, expect, it, vi } from 'vitest'

vi.mock('./external', () => ({
  externalBridge: {
    openExternal: vi.fn(async () => undefined),
    fetchLinkTitle: vi.fn()
  }
}))

import { externalBridge } from './external'
import { previewOpenBridge } from './preview-open'

describe('hermesDesktop preview open', () => {
  it('openPreviewInBrowser delegates to openExternal', async () => {
    await previewOpenBridge.openPreviewInBrowser!('https://example.test/doc')

    expect(externalBridge.openExternal).toHaveBeenCalledWith('https://example.test/doc')
  })

  it('setPreviewShortcutActive is callable', () => {
    expect(() => previewOpenBridge.setPreviewShortcutActive!(true)).not.toThrow()
  })
})
