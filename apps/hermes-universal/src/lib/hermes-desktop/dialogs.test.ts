import { beforeEach, describe, expect, it, vi } from 'vitest'

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }))

vi.mock('@tauri-apps/plugin-dialog', () => dialog)

import { dialogsBridge } from './dialogs'

beforeEach(() => {
  dialog.open.mockReset()
  dialog.save.mockReset()
})

describe('hermesDesktop.selectPaths', () => {
  it('answers a list, whatever shape the plugin answers in', async () => {
    dialog.open.mockResolvedValueOnce(['/a', '/b']).mockResolvedValueOnce('/c').mockResolvedValueOnce(null)

    await expect(dialogsBridge.selectPaths()).resolves.toEqual(['/a', '/b'])
    await expect(dialogsBridge.selectPaths({ multiple: false })).resolves.toEqual(['/c'])
    await expect(dialogsBridge.selectPaths()).resolves.toEqual([])
  })

  it('maps Electron’s options, several by default', async () => {
    dialog.open.mockResolvedValue(null)

    await dialogsBridge.selectPaths({ defaultPath: '/work', directories: true, profile: 'p', title: 'Pick' })
    await dialogsBridge.selectPaths({ filters: [{ extensions: ['png'], name: 'Images' }], multiple: false })

    expect(dialog.open.mock.calls).toEqual([
      [{ defaultPath: '/work', directory: true, filters: undefined, multiple: true, title: 'Pick' }],
      [
        {
          defaultPath: undefined,
          directory: false,
          filters: [{ extensions: ['png'], name: 'Images' }],
          multiple: false,
          title: undefined
        }
      ]
    ])
  })
})

describe('hermesDesktop.selectSavePath', () => {
  it('answers the path, or null when the dialog was dismissed', async () => {
    dialog.save.mockResolvedValueOnce('/out/a.md').mockResolvedValueOnce(null)

    await expect(dialogsBridge.selectSavePath!({ defaultPath: 'a.md' })).resolves.toBe('/out/a.md')
    await expect(dialogsBridge.selectSavePath!()).resolves.toBeNull()
  })
})
