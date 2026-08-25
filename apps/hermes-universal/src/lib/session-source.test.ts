import { describe, expect, it, vi } from 'vitest'

/**
 * `source` decides the session's PLATFORM on the gateway, and "desktop" is the
 * literal that unlocks the `desktop_ui` toolset (`_gui_surface_toolsets` in
 * tui_gateway/server.py). Universal answers every one of those bridges, so it
 * says so — but only inside the app shell.
 */
describe('SESSION_SOURCE_PARAMS', () => {
  it('claims the desktop surface inside the Tauri shell', async () => {
    vi.resetModules()
    vi.doMock('@/lib/platform', () => ({ IS_TAURI: true }))

    const { SESSION_SOURCE_PARAMS } = await import('./session-source')

    expect(SESSION_SOURCE_PARAMS).toEqual({ source: 'desktop' })
    expect({ cols: 96, ...SESSION_SOURCE_PARAMS }).toEqual({ cols: 96, source: 'desktop' })

    vi.doUnmock('@/lib/platform')
  })

  it('claims nothing in a plain browser, which answers none of those bridges', async () => {
    vi.resetModules()
    vi.doMock('@/lib/platform', () => ({ IS_TAURI: false }))

    const { SESSION_SOURCE_PARAMS } = await import('./session-source')

    expect({ cols: 96, ...SESSION_SOURCE_PARAMS }).toEqual({ cols: 96 })

    vi.doUnmock('@/lib/platform')
  })
})
