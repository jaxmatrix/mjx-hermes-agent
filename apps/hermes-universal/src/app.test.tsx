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
 *
 * The folder-pick prompt (`ExplorerPathDialog`) joins them for the same reason:
 * it is asked from a tree row's context menu and a search hit's menu, both
 * transient, so the window has to own it, in every root.
 *
 * The DESKTOP MAIN WINDOW is the one root that is not universal's: it renders
 * desktop's own root, whose wiring mounts desktop's twins of these surfaces, so
 * `App` adds only what desktop has no counterpart for.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/index', () => ({ default: () => <div>desktop</div> }))
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
// Stubbed like its neighbours: the real dialog reaches `store/explorer-path` →
// `store/session-states` → the pane-shell layout store, which calls
// `isSecondaryWindow()` at module scope against the partial `@/store/windows` mock.
vi.mock('@/app/explorer-path-dialog', () => ({
  ExplorerPathDialog: () => <div data-testid="explorer-path-dialog" />
}))

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
// The frameless window's own min / max / close. Stubbed: the real one reaches
// the Tauri window API, and this file is about WHICH windows get one.
vi.mock('@/app/shell/window-chrome', () => ({ WindowChrome: () => <div data-testid="window-chrome" /> }))
vi.mock('@/lib/hermes-desktop/window-chrome', () => ({ hostsWindowChrome: () => root.chrome }))
vi.mock('@/store/mcp-health', () => ({ startMcpHealthChecker: vi.fn() }))

// `vi.hoisted`, not three `let`s: the mock factory below is called during the
// import of `./app`, which ESM evaluates BEFORE any module-scope `let` in this
// file has initialised. `pane-shell/tree/store` calls `isSecondaryWindow()` at
// module scope, so a plain `let` is a temporal-dead-zone crash the moment this
// file's graph reaches the layout tree — which MJXHRM-455 and then MJXHRM-478
// each widened it into.
const root = vi.hoisted(() => ({
  activity: false,
  chrome: true,
  mobile: false,
  surface: null as null | string,
  tile: false
}))

// `IS_MOBILE` is a boot-time constant; a getter lets one file render both the
// phone's main window and the desktop's.
vi.mock('@/lib/platform', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  get IS_MOBILE() {
    return root.mobile
  }
}))

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
import { $sshPrompt } from '@/store/ssh-backend'
import { WAKE_INDICATOR_SURFACE } from '@/store/windows'

import { App } from './app'

// The hosts' chunk holds the real context-menu coordinator, whose graph takes
// longer to transform on first import than `findBy*` waits. A window pays that
// once at boot; here it is paid before the first test instead of inside one.
beforeAll(async () => {
  await import('@/app/window-hosts')
})

beforeEach(() => {
  root.activity = false
  root.chrome = true
  root.mobile = false
  root.tile = false
  root.surface = null
})

const ROOTS: [name: string, arrange: () => void, marker: string][] = [
  ['the phone shell', () => void (root.mobile = true), 'shell'],
  ['a detached tile window', () => void (root.tile = true), 'tile'],
  ['the HUD', () => void (root.surface = HUD_SURFACE), 'hud'],
  ['Quick Entry', () => void (root.surface = QUICK_ENTRY_SURFACE), 'quick'],
  ['the wake indicator light', () => void (root.surface = WAKE_INDICATOR_SURFACE), 'wake'],
  ['an activity screen', () => void (root.activity = true), 'activity']
]

describe('App', () => {
  it('renders desktop’s own root in the desktop main window, without doubling what its wiring mounts', async () => {
    render(<App />)

    expect(await screen.findByText('desktop')).toBeInTheDocument()
    expect(screen.queryByText('shell')).not.toBeInTheDocument()
    expect(screen.queryByTestId('find-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('remote-picker')).not.toBeInTheDocument()
    expect(screen.queryByTestId('close-confirm')).not.toBeInTheDocument()
    expect(screen.queryByTestId('explorer-path-dialog')).not.toBeInTheDocument()
  })

  // Electron's frame gives desktop's root its buttons and a titlebar that moves
  // the window; a frameless Tauri window has neither unless `App` mounts them —
  // and it has to before the root's chunk arrives, or a root that fails to load
  // is a window that cannot be closed.
  it('gives the window that renders desktop’s root its min / max / close, before the root has loaded', async () => {
    render(<App />)

    expect(screen.getByTestId('window-chrome')).toBeInTheDocument()
    expect(await screen.findByText('desktop')).toBeInTheDocument()
  })

  it('draws no window chrome where desktop’s root is not on a desktop OS', async () => {
    root.chrome = false
    render(<App />)

    expect(await screen.findByText('desktop')).toBeInTheDocument()
    expect(screen.queryByTestId('window-chrome')).not.toBeInTheDocument()
  })

  it.each(ROOTS)('leaves %s its own chrome', async (_name, arrange, marker) => {
    arrange()
    render(<App />)

    expect(await screen.findByText(marker)).toBeInTheDocument()
    expect(screen.queryByTestId('window-chrome')).not.toBeInTheDocument()
  })

  it('still asks a pending SSH question in the desktop main window', () => {
    $sshPrompt.set({
      attemptId: 'a1',
      kind: 'passphrase',
      label: 'Passphrase for id_ed25519',
      promptId: 'p1',
      secret: true
    })

    try {
      render(<App />)

      expect(screen.getByText('Passphrase for id_ed25519')).toBeInTheDocument()
    } finally {
      $sshPrompt.set(null)
    }
  })

  it('keeps a tile window universal’s even on a desktop', async () => {
    root.tile = true
    render(<App />)

    expect(await screen.findByText('tile')).toBeInTheDocument()
    expect(screen.queryByText('desktop')).not.toBeInTheDocument()
  })

  it.each(ROOTS)('mounts the find bar, the folder picker and the two gates in %s', async (_name, arrange, marker) => {
    arrange()

    render(<App />)

    // The root and its hosts are two chunks under ONE boundary: they arrive together.
    expect(await screen.findByText(marker)).toBeInTheDocument()
    expect(screen.getByTestId('find-bar')).toBeInTheDocument()
    expect(screen.getByTestId('remote-picker')).toBeInTheDocument()
    expect(screen.getByTestId('close-confirm')).toBeInTheDocument()
    expect(screen.getByTestId('explorer-path-dialog')).toBeInTheDocument()
  })

  it('loads a window’s own root and no other', async () => {
    // Each root is a chunk: a phone must not parse desktop's shell, and under the
    // dev server a root that does not link must not blank a window that never
    // mounts it. A static import of any root from `app.tsx` undoes both.
    const source = await import('node:fs').then(fs => fs.readFileSync('src/app.tsx', 'utf8'))
    const statics = [...source.matchAll(/^import (?!type )[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1])

    expect(statics.sort()).toEqual([
      '@/app/background-close-dialog',
      '@/app/gateway/ssh-prompt-dialog',
      '@/app/shell/window-chrome',
      '@/app/wake-indicator-overlay',
      '@/lib/hermes-desktop/window-chrome',
      '@/lib/platform',
      '@/store/deep-link',
      '@/store/windows',
      'react'
    ])
  })

  // MJXHRM-592: a switch or a tunnel's Connect can ask for a credential from
  // anywhere, so the question is the window's, not the configurator's.
  it.each(ROOTS)('asks a pending SSH question in %s', (_name, arrange) => {
    arrange()
    $sshPrompt.set({
      attemptId: 'a1',
      kind: 'passphrase',
      label: 'Passphrase for id_ed25519',
      promptId: 'p1',
      secret: true
    })

    try {
      render(<App />)

      expect(screen.getByText('Passphrase for id_ed25519')).toBeInTheDocument()
    } finally {
      $sshPrompt.set(null)
    }
  })

  it.each(ROOTS)('owns the right-click gesture in %s', async (_name, arrange, marker) => {
    arrange()
    render(<App />)
    await screen.findByText(marker)

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
