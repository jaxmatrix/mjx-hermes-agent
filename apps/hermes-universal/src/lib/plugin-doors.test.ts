/**
 * The two plugin transport doors. What matters here is the BOUNDARY: `path` is
 * relative to `/api/plugins/<id>` and must not be able to normalize out of that
 * namespace, whichever door it is asked through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => vi.fn(async () => ({ ok: true })))

const { pluginRest } = await import('@/api/plugins')
const { setApiRequestProfile } = await import('@/hermes')

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop

beforeEach(() => {
  api.mockClear()
  api.mockResolvedValue({ ok: true })
  desktopWindow.hermesDesktop = { api } as unknown as Window['hermesDesktop']
  setApiRequestProfile(null)
})

afterEach(() => {
  desktopWindow.hermesDesktop = initialHermesDesktop
  vi.clearAllMocks()
})

describe('pluginRest', () => {
  it('scopes the call to the plugin namespace', async () => {
    await pluginRest('kanban', '/board')

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/plugins/kanban/board' })
    )
  })

  it('accepts a path with no leading slash', async () => {
    await pluginRest('kanban', 'board')

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/plugins/kanban/board' })
    )
  })

  it('rejects traversal out of the namespace', async () => {
    for (const path of ['/../other/board', '../other', '/a/../../core', '/..']) {
      await expect(pluginRest('kanban', path)).rejects.toThrow(/illegal path traversal/)
    }

    expect(api).not.toHaveBeenCalled()
  })

  it('allows `..` inside a query string — only the path portion is the boundary', async () => {
    await pluginRest('kanban', '/search?q=../x')

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/plugins/kanban/search?q=../x' })
    )
  })

  it('threads the active profile', async () => {
    setApiRequestProfile('work')
    await pluginRest('kanban', '/board')

    expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/plugins/kanban/board', profile: 'work' }))
  })

  it('refuses to call when the desktop bridge is missing', async () => {
    desktopWindow.hermesDesktop = undefined

    await expect(pluginRest('kanban', '/board')).rejects.toThrow(/bridge unavailable/)
  })

  it('forwards an upload to the bridge', async () => {
    const upload = { bytes: new ArrayBuffer(4), filename: 'a.csv' }
    await pluginRest('kanban', '/import', { method: 'POST', upload })

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/plugins/kanban/import',
        upload
      })
    )
  })

  it('passes method and body through', async () => {
    await pluginRest('kanban', '/board', { body: { title: 'x' }, method: 'POST' })

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { title: 'x' },
        method: 'POST',
        path: '/api/plugins/kanban/board'
      })
    )
  })
})
