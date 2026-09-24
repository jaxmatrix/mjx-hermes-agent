import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][]
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])

    if (command === 'marketplace_search') {
      return [{ extensionId: 'a.b', displayName: 'A', publisher: 'p', description: '', installs: 1 }]
    }

    if (command === 'marketplace_fetch') {
      return { extensionId: 'a.b', displayName: 'A', themes: [] }
    }

    return undefined
  })
}))

import { themesBridge } from './themes'

beforeEach(() => {
  native.calls = []
})

describe('hermesDesktop.themes', () => {
  it('search / fetch invoke marketplace_*', async () => {
    await expect(themesBridge.themes.searchMarketplace('dracula')).resolves.toHaveLength(1)
    await expect(themesBridge.themes.fetchMarketplace('a.b')).resolves.toMatchObject({
      extensionId: 'a.b'
    })

    expect(native.calls).toEqual([
      ['marketplace_search', { query: 'dracula', limit: 20 }],
      ['marketplace_fetch', { id: 'a.b' }]
    ])
  })
})
