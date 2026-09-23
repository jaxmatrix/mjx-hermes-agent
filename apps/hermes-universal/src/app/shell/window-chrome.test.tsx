import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

const { drag, platform, win } = vi.hoisted(() => ({
  drag: { disarm: vi.fn(), install: vi.fn() },
  platform: { desktop: true, mac: false },
  win: {
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    minimize: vi.fn(),
    onResized: vi.fn().mockResolvedValue(() => {}),
    toggleMaximize: vi.fn()
  }
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }))
vi.mock('@/lib/window-drag', () => ({ installWindowDrag: drag.install }))
vi.mock('@/lib/platform', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  get IS_DESKTOP() {
    return platform.desktop
  },
  get IS_MAC() {
    return platform.mac
  }
}))

import {
  hostsWindowChrome,
  installWindowControlsOverlay,
  WINDOW_CHROME_MAC_WIDTH,
  WINDOW_CHROME_MAC_X,
  WINDOW_CHROME_WIDTH,
  windowChromeInsets
} from '@/lib/hermes-desktop/window-chrome'

import { TITLEBAR_CONTROL_OFFSET_X, TITLEBAR_HEIGHT } from './titlebar'
import { WindowChrome } from './window-chrome'

const renderChrome = () =>
  render(
    <I18nProvider>
      <WindowChrome />
    </I18nProvider>
  )

const box = (): HTMLElement => document.querySelector<HTMLElement>('[data-window-chrome]')!

beforeEach(() => {
  vi.clearAllMocks()
  drag.install.mockReturnValue(drag.disarm)
  platform.desktop = true
  platform.mac = false
  window.history.replaceState(null, '', '/')
})

describe('WindowChrome', () => {
  it('puts min / max / close in the top-right corner, in the box the descriptor reports', () => {
    renderChrome()

    expect(box().dataset.windowChrome).toBe('right')
    expect(box().style.right).toBe('0px')
    expect(box().style.width).toBe(`${WINDOW_CHROME_WIDTH}px`)
    expect(box().style.height).toBe(`${TITLEBAR_HEIGHT}px`)
    expect(windowChromeInsets()).toEqual({ nativeOverlayWidth: WINDOW_CHROME_WIDTH, windowButtonPosition: null })
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'Minimize',
      'Maximize',
      'Close'
    ])
  })

  it('puts them where the traffic lights go on macOS, close first', () => {
    platform.mac = true
    renderChrome()

    expect(box().dataset.windowChrome).toBe('left')
    expect(box().style.left).toBe(`${WINDOW_CHROME_MAC_X}px`)
    expect(box().style.width).toBe(`${WINDOW_CHROME_MAC_WIDTH}px`)
    expect(windowChromeInsets()).toEqual({
      nativeOverlayWidth: 0,
      windowButtonPosition: { x: WINDOW_CHROME_MAC_X, y: expect.any(Number) }
    })
    // Desktop starts its left cluster at `x + TITLEBAR_CONTROL_OFFSET_X`.
    expect(WINDOW_CHROME_MAC_X + WINDOW_CHROME_MAC_WIDTH).toBeLessThanOrEqual(
      WINDOW_CHROME_MAC_X + TITLEBAR_CONTROL_OFFSET_X
    )
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'Close',
      'Minimize',
      'Maximize'
    ])
  })

  // `close()` is a request: the window close guard decides what it means.
  it('asks the window to close rather than destroying it', () => {
    renderChrome()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(win.close).toHaveBeenCalledOnce()
  })

  it('arms the titlebar drag for as long as it is mounted', () => {
    const { unmount } = renderChrome()

    expect(drag.install).toHaveBeenCalledOnce()
    expect(drag.disarm).not.toHaveBeenCalled()

    unmount()
    expect(drag.disarm).toHaveBeenCalledOnce()
  })
})

describe('hostsWindowChrome', () => {
  it('is the windows that render desktop’s root on a desktop OS', () => {
    expect(hostsWindowChrome()).toBe(true)

    for (const kind of ['tile', 'hud', 'quick', 'wake', 'activity', 'secondary']) {
      window.history.replaceState(null, '', `/?win=${kind}`)
      expect([kind, hostsWindowChrome()]).toEqual([kind, false])
      expect(windowChromeInsets()).toEqual({ nativeOverlayWidth: 0, windowButtonPosition: null })
    }
  })

  it('is never a phone', () => {
    platform.desktop = false

    expect(hostsWindowChrome()).toBe(false)
    expect(windowChromeInsets()).toEqual({ nativeOverlayWidth: 0, windowButtonPosition: null })
  })
})

// Desktop's titlebar prefers Chromium's Window Controls Overlay to the
// descriptor, and the descriptor does not exist until a connection resolves.
describe('installWindowControlsOverlay', () => {
  const overlay = () =>
    (navigator as Navigator & { windowControlsOverlay?: { getTitlebarAreaRect: () => DOMRect; visible: boolean } })
      .windowControlsOverlay

  beforeEach(() => {
    delete (navigator as { windowControlsOverlay?: unknown }).windowControlsOverlay
  })

  it('publishes the box the way desktop measures it: viewport width minus the titlebar area’s right edge', () => {
    installWindowControlsOverlay()

    expect(overlay()?.visible).toBe(true)
    expect(Math.round(window.innerWidth - overlay()!.getTitlebarAreaRect().right)).toBe(WINDOW_CHROME_WIDTH)
  })

  it('publishes nothing on macOS, in a window with its own chrome, or on a phone', () => {
    platform.mac = true
    installWindowControlsOverlay()
    expect(overlay()).toBeUndefined()

    platform.mac = false
    window.history.replaceState(null, '', '/?win=tile')
    installWindowControlsOverlay()
    expect(overlay()).toBeUndefined()

    window.history.replaceState(null, '', '/')
    platform.desktop = false
    installWindowControlsOverlay()
    expect(overlay()).toBeUndefined()
  })
})
