/**
 * The surfaces that must exist in EVERY window root.
 *
 * All three were shipped mounted inside one root and silently dead in the
 * others — the folder picker (fixed earlier), the ⌘F find bar (MJXHRM-387),
 * which searched the main shell and nothing else while a detached chat window,
 * the HUD and the Android activity screen all render real text, and the close
 * confirmation (MJXHRM-390), which lived in `ContribController` — the DOCKED
 * TILE TREE only — so a phone could park a "this chat is still working" prompt
 * that nothing would ever draw.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/activity-screen', () => ({ ActivityScreenRoot: () => <div>activity</div> }))
vi.mock('@/app/hud/hud-window', () => ({ HudWindowRoot: () => <div>hud</div> }))
vi.mock('@/app/mobile-controller', () => ({ MobileController: () => <div>shell</div> }))
vi.mock('@/app/quick-entry/quick-entry-window', () => ({ QuickEntryWindowRoot: () => <div>quick</div> }))
vi.mock('@/app/tile-window', () => ({ TileWindowRoot: () => <div>tile</div> }))
vi.mock('@/app/wake-indicator/wake-indicator-window', () => ({ WakeIndicatorWindowRoot: () => <div>wake</div> }))
vi.mock('@/app/right-pane/files/remote-picker', () => ({
  RemoteFolderPicker: () => <div data-testid="remote-picker" />
}))
vi.mock('@/components/find-bar', () => ({ FindBar: () => <div data-testid="find-bar" /> }))
vi.mock('@/app/close-confirm', () => ({ CloseConfirm: () => <div data-testid="close-confirm" /> }))

// Side-effect starters App() arms at mount, not surfaces it renders. Stubbed so
// this file stays about WHICH roots mount — the real ones reach the gateway,
// @/store/windows and the Tauri event bus (MJXHRM-454).
vi.mock('@/app/mcp-install-deeplink-dialog', () => ({ McpInstallDeepLinkDialog: () => null }))
// MJXHRM-455's twin of the line above, and it is load-bearing for more than
// tidiness: the real modal reaches `contrib/runtime-loader` → `sdk/index.ts` →
// `pane-shell/tree/store`, whose module scope calls `isSecondaryWindow()`. That
// widened THIS file's import graph into the partial `@/store/windows` mock
// below and turned the whole file into a collect-time crash.
vi.mock('@/app/settings/plugin-install-modal', () => ({ PluginInstallModal: () => null }))
vi.mock('@/store/deep-link', () => ({ startDeepLinkRouter: vi.fn() }))
vi.mock('@/store/mcp-health', () => ({ startMcpHealthChecker: vi.fn() }))

// `vi.hoisted`, not three `let`s: the mock factory below is called during the
// import of `./app`, which ESM evaluates BEFORE any module-scope `let` in this
// file has initialised. `pane-shell/tree/store` calls `isSecondaryWindow()` at
// module scope, so a plain `let` is a temporal-dead-zone crash the moment this
// file's graph reaches the layout tree — which MJXHRM-455 and then MJXHRM-478
// each widened it into.
const root = vi.hoisted(() => ({ activity: false, surface: null as null | string, tile: false }))

// Spread the REAL module and override only the four window-identity answers.
// The previous shape listed the exports this file happened to reach, and its own
// comment said what that costs: `AppContextMenu` (MJXHRM-478) pulled
// `pane-shell/tree/store.ts` onto the graph, which reads `isSecondaryWindow` at
// module scope, and the mock crashed the suite instead of failing an assertion.
vi.mock('@/store/windows', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  canOpenSatelliteWindow: () => true,
  closeSatelliteWindow: async () => undefined,
  isActivityWindow: () => root.activity,
  isSatelliteWindow: () => root.surface !== null,
  // Read at MODULE SCOPE by `pane-shell/tree/store`, so its absence is a
  // collect-time crash rather than a failed assertion the moment anything in
  // this file's graph reaches the layout tree — which is exactly what the
  // comment above predicted and what MJXHRM-455 triggered.
  isSecondaryWindow: () => root.tile || root.surface !== null,
  isTileWindow: () => root.tile,
  openSatelliteWindow: async () => null,
  ownsPersistedAppState: () => !root.activity && !root.tile && root.surface === null,
  satelliteSurface: () => root.surface
}))

import { HUD_SURFACE } from '@/app/hud/hud'
import { QUICK_ENTRY_SURFACE } from '@/app/quick-entry/quick-entry'
import { WAKE_INDICATOR_SURFACE } from '@/store/windows'

import { App } from './app'

beforeEach(() => {
  root.activity = false
  root.tile = false
  root.surface = null
})

const ROOTS: [name: string, arrange: () => void, marker: string][] = [
  ['the main shell', () => undefined, 'shell'],
  ['a detached tile window', () => void (root.tile = true), 'tile'],
  ['the HUD', () => void (root.surface = HUD_SURFACE), 'hud'],
  ['Quick Entry', () => void (root.surface = QUICK_ENTRY_SURFACE), 'quick'],
  ['the wake indicator light', () => void (root.surface = WAKE_INDICATOR_SURFACE), 'wake'],
  ['an activity screen', () => void (root.activity = true), 'activity']
]

describe('App', () => {
  it.each(ROOTS)('mounts the find bar, the folder picker and the close gate in %s', (_name, arrange, marker) => {
    arrange()

    render(<App />)

    expect(screen.getByText(marker)).toBeInTheDocument()
    expect(screen.getByTestId('find-bar')).toBeInTheDocument()
    expect(screen.getByTestId('remote-picker')).toBeInTheDocument()
    expect(screen.getByTestId('close-confirm')).toBeInTheDocument()
  })

  it.each(ROOTS)('owns the right-click gesture in %s', (_name, arrange) => {
    arrange()
    render(<App />)

    const link = document.createElement('a')

    link.href = 'https://example.test/'
    document.body.append(link)

    const gesture = new MouseEvent('contextmenu', { bubbles: true, button: 2, cancelable: true })

    fireEvent(link, gesture)

    // A root without the coordinator does not merely lose the Hermes menu — on
    // Tauri it shows WebKitGTK's own "Reload / Inspect Element" instead, because
    // nothing cancelled the gesture.
    expect(gesture.defaultPrevented).toBe(true)
    expect(screen.getByText('Copy URL')).toBeInTheDocument()

    link.remove()
  })
})
