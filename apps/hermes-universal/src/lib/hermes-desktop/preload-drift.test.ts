import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The shim-drift test. Electron's preload IS the bridge's specification, and a
// resync can add a member to it without anyone here noticing: desktop's new call
// site then throws (or, optional-chained, silently does nothing) in universal
// only. So the preload is parsed and every member it exposes has to be accounted
// for — implemented by universal's bridge, or named in `NOT_YET` with the reason.

const os = vi.hoisted(() => ({ platform: 'linux' }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/plugin-os', () => ({
  platform: () => {
    if (os.platform === 'none') {
      throw new Error('no runtime')
    }

    return os.platform
  },
  version: () => '1.0.0'
}))

const PRELOAD = path.resolve(process.cwd(), '../desktop/electron/preload.ts')

/**
 * What the bridge does not implement, and why. A key is a member
 * (`getVersion`), a member of a namespace (`profile.set`) or a whole namespace
 * (`git`), which covers everything under it.
 *
 * THIS TABLE ONLY SHRINKS. An entry leaves when its member is implemented (the
 * test fails until it does), and `NOT_YET_SIZE` is lowered with it.
 */
const NOT_YET: Record<string, string> = {
  // -- decided: another owner, or no correct mapping ---------------------------
  getPathForFile:
    'no mapping: a Tauri webview never sees a dropped File’s path; OS drops arrive as paths on onDragDropEvent (app/chat/use-file-drop.ts)',
  onDeepLink:
    'owned elsewhere: store/deep-link.ts consumes every hermes:// kind in every window kind; a second handler would act on each link twice',
  signalDeepLinkReady: 'owned elsewhere: the router drains Rust’s buffer itself (deep_link_ready), after it subscribes',
  onNotificationActivate:
    'cannot fire: tauri-plugin-notification has no click hook on a desktop OS; a phone’s tap goes through store/plugin-notify-handlers.ts',
  onNotificationAction:
    'cannot fire: no notification buttons on a desktop OS, and no phone root listens for an approval’s',
  onFocusSession: 'cannot fire: no notification click on a desktop OS',
  openSessionWindow:
    'owned elsewhere: store/windows.ts opens every window kind through Rust itself — it flushes the composer drafts first and records the pop-out so its close hands the stream back; no caller reaches for the bridge',
  openWindow: 'owned elsewhere: store/windows.ts (open_instance_window); no caller reaches for the bridge',
  onWindowStateChanged:
    'no correct mapping: isFullscreen must stay false (universal’s drawn window buttons stay in fullscreen, so desktop must keep its inset), and Tauri raises no minimize or visibility event — the DOM’s visibilitychange, which desktop’s pause controller also reads, is the signal',
  setTitleBarTheme: 'no mapping: every window is frameless, and universal’s own window buttons take the theme from CSS',
  setDisableF12: 'no mapping: a release build has no devtools (no `devtools` cargo feature), so F12 opens nothing',
  setActiveConnectionRoute:
    'no mapping: Electron holds a route per window to reach previews through; browser_reach_url takes the scope on every call, so Rust has nothing to hold',
  getPoolLimits: 'no mapping: no backend pool — one unified server per connection serves every profile',
  setPoolLimits: 'no mapping: no backend pool — one unified server per connection serves every profile',

  // -- needs Rust ---------------------------------------------------------------
  readFileDataUrlForAttach:
    'needs Rust: read_capped_file_base64 has one cap (the user’s); the caller falls back to readFileDataUrl',
  setActiveWork:
    'needs Rust: a process-wide quit guard (per-webview reports merged at quit_app / last window) and its dialog copy',
  claimAmbientCue: 'needs Rust: a cross-window arbiter; also what would dedupe one OS notification across peer windows',
  saveImageBuffer: 'needs Rust: a binary write into app data (composer-images)',
  savePastedText: 'needs Rust: a write into app data',
  saveClipboardImage: 'needs Rust: clipboard image → app data',
  readFileText: 'needs Rust: a capped local text read with binary sniffing',
  readDir: 'needs Rust: a local directory listing',
  gitRoot: 'needs Rust: local git discovery',
  renamePath: 'needs Rust: local rename',
  writeTextFile: 'needs Rust: hardened local text write',
  trashPath: 'needs Rust: OS trash',
  openDir: 'needs Rust: mkdir -p + open in the file manager',
  watchPreviewFile: 'needs Rust: file watcher',
  watchDirectory: 'needs Rust: directory watcher',
  stopPreviewFileWatch: 'needs Rust: file watcher',
  onPreviewFileChanged: 'needs Rust: file watcher',
  normalizePreviewTarget: 'needs Rust: local path resolution for previews',
  capturePreview: 'needs Rust: guest webview capture',
  resolveFavicon: 'needs Rust: favicon fetch + cache',
  sanitizeWorkspaceCwd: 'needs Rust: local cwd validation',
  getOnBattery: 'needs Rust: power source',
  onBatteryChanged: 'needs Rust: power source',
  getMachineProfile: 'needs Rust: host facts',
  getRemoteDisplayReason: 'needs Rust: remote-display detection',
  revealLogs: 'needs Rust: the log file’s path',
  getRecentLogs: 'needs Rust: the log ring',
  reportRendererError: 'needs Rust: a log sink for renderer crashes',
  logsRoot: 'needs Rust: the log directory',
  contextMenuSpellcheck: 'needs Rust: no spellcheck API on a Tauri webview',
  contextMenuGuestAddWord: 'needs Rust: no spellcheck API on a Tauri webview',
  onContextMenuSpellcheck: 'needs Rust: no spellcheck API on a Tauri webview',
  'connections.updateManaged':
    'needs Rust: a transactional update of an SSH install it manages (drain, update, prove, restore); desktop’s section feature-detects it',
  saveGatewayFile:
    'needs Rust: a download scoped by connection, profile and session — download_file follows media_set_target, the active source only',
  mcpOauth: 'needs Rust: a one-shot loopback listener (listen / wait / cancel) for MCP OAuth redirects',
  openSessionInTerminal:
    'needs Rust: a launcher that resumes the session in the TUI (`hermes --tui --resume`); open_in_terminal only opens a shell at a directory',

  // -- batch 3: windows, updates, themes, git, terminal, satellites -------------
  openBrowserWindow: 'batch 3: the in-app browser’s pop-out',
  onBrowserPopoutClosed: 'batch 3: the in-app browser’s pop-out',
  setPreviewShortcutActive: 'batch 3: preview pane shortcuts',
  openPreviewInBrowser: 'batch 3: preview pane',
  reachPreviewUrl: 'batch 3: browser_reach_url',
  onClosePreviewRequested: 'batch 3: menu accelerators',
  onPreviewNav: 'batch 3: menu accelerators',
  onOpenFolderRequested: 'batch 3: menu accelerators',
  onOpenUpdatesRequested: 'batch 3: menu accelerators',
  onOpenFindBarRequested: 'batch 3: menu accelerators',
  findInPage: 'batch 3: find_in_page',
  stopFindInPage: 'batch 3: stop_find_in_page',
  onFoundInPage: 'batch 3: find_in_page',
  contextMenuEdit: 'batch 3: the context menu’s edit verbs (app/context-menu/actions.ts)',
  contextMenuCopyImage: 'batch 3: context_menu_copy_image',
  updates: 'batch 3: update_check / update_install',
  getVersion: 'batch 3: app version, with updates',
  relaunchApp: 'batch 3: relaunch, with updates',
  uninstall: 'batch 3: no uninstaller on Tauri — decide absent-for-good',
  themes: 'batch 3: marketplace_search / marketplace_fetch',
  git: 'batch 3: local git',
  terminal: 'batch 3: pty_*',
  petOverlay: 'batch 3: the pet’s own window',
  quickEntry: 'batch 3: the quick-entry satellite',
  hud: 'batch 3: the HUD satellite',
  chatOnboarding: 'batch 3: onboarding window growth',
  introReveal: 'batch 3: the first-run film',
  readPluginSource: 'batch 3: plugins_read',
  desktopPluginsRoot: 'batch 3: plugins_root',
  reconcileDesktopPlugins: 'batch 3: plugins_list',
  probePluginRepo: 'batch 3: plugin install',
  installDesktopPlugin: 'batch 3: plugin install',
  getBootstrapState: 'batch 3: local_install_*',
  continueBootstrapLocal: 'batch 3: local_install_*',
  resetBootstrap: 'batch 3: local_install_*',
  repairBootstrap: 'batch 3: local_install_*',
  cancelBootstrap: 'batch 3: local_install_cancel',
  onBootstrapEvent: 'batch 3: local_install_*',
  localModelsEnabled: 'batch 3: launch flag — get_app_flag is async, and this is read synchronously',
  guestOnboardingEnabled: 'batch 3: launch flag — get_app_flag is async, and this is read synchronously',
  skipIntro: 'batch 3: launch flag — get_app_flag is async, and this is read synchronously',

  // -- post-Nous thin-host: new preload members not yet ported -----------------
  windowControls: 'needs Rust: custom titlebar window controls (minimize/maximize/close)',
  hudModifier: 'needs Rust: HUD modifier key tracking',
  screenshot: 'needs Rust: desktop screenshot capture',
  'profile.getDefault': 'needs Rust: default profile preference (partial profile namespace)',
  'profile.setDefault': 'needs Rust: default profile preference (partial profile namespace)',
  'profile.onDefaultChanged': 'needs Rust: default profile preference (partial profile namespace)',
  minimizeToTray: 'needs Rust: minimize-to-tray preference',
  removeDesktopPlugin: 'batch 3: plugin uninstall (with installDesktopPlugin)',
  onPoolBackendRetiring: 'no mapping: no backend pool — one unified server per connection'
}

/** Lower it when an entry leaves. It does not go up without a decision. */
const NOT_YET_SIZE = 100

/** Every member the preload exposes: `notify`, `zoom.get`, `git.review.list`. */
function preloadSurface(): string[] {
  const source = ts.createSourceFile(PRELOAD, fs.readFileSync(PRELOAD, 'utf8'), ts.ScriptTarget.Latest, true)
  const members: string[] = []

  const collect = (literal: ts.ObjectLiteralExpression, prefix: string) => {
    for (const property of literal.properties) {
      const name = property.name?.getText(source)

      if (!name) {
        throw new Error('the preload spreads or computes a member — teach this test to read it')
      }

      if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
        collect(property.initializer, `${prefix}${name}.`)
      } else {
        members.push(`${prefix}${name}`)
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'contextBridge.exposeInMainWorld' &&
      ts.isStringLiteral(node.arguments[0]!) &&
      node.arguments[0].text === 'hermesDesktop' &&
      ts.isObjectLiteralExpression(node.arguments[1]!)
    ) {
      collect(node.arguments[1], '')
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return members
}

function flatten(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, member]) =>
    member && typeof member === 'object' && !Array.isArray(member)
      ? flatten(member as object, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  )
}

/** The bridge as installed on a platform (a phone has members a desktop lacks). */
async function bridgeSurface(platform: string): Promise<string[]> {
  os.platform = platform
  vi.resetModules()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop

  const { installHermesDesktopBridge } = await import('.')

  installHermesDesktopBridge()

  return flatten(window.hermesDesktop as object)
}

const waived = (member: string): boolean =>
  Object.keys(NOT_YET).some(key => member === key || member.startsWith(`${key}.`))

beforeEach(() => {
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('the bridge against Electron’s preload', () => {
  it('reads the preload', () => {
    const surface = preloadSurface()

    expect(surface).toContain('openExternal')
    expect(surface).toContain('zoom.factor')
    expect(surface).toContain('git.review.createPr')
    expect(surface.length).toBeGreaterThan(200)
  })

  it('accounts for every member: implemented, or in NOT_YET with a reason', async () => {
    const implemented = new Set([...(await bridgeSurface('linux')), ...(await bridgeSurface('android'))])
    const undecided = preloadSurface().filter(member => !implemented.has(member) && !waived(member))

    expect(undecided).toEqual([])
  })

  it('implements nothing the preload does not expose', async () => {
    const surface = new Set(preloadSurface())
    const implemented = [...(await bridgeSurface('linux')), ...(await bridgeSurface('android'))]

    expect(implemented.filter(member => !surface.has(member))).toEqual([])
  })

  it('keeps NOT_YET honest: no entry is implemented, stale, or unexplained', async () => {
    const surface = preloadSurface()
    const implemented = new Set([...(await bridgeSurface('linux')), ...(await bridgeSurface('android'))])

    for (const [key, reason] of Object.entries(NOT_YET)) {
      const covered = surface.filter(member => member === key || member.startsWith(`${key}.`))

      expect([key, covered.length > 0]).toEqual([key, true])
      expect([key, covered.filter(member => implemented.has(member))]).toEqual([key, []])
      expect(reason.length).toBeGreaterThan(10)
    }
  })

  it('has a namespace whole or not at all, bar the members NOT_YET names', async () => {
    const surface = preloadSurface()
    const implemented = new Set([...(await bridgeSurface('linux')), ...(await bridgeSurface('android'))])

    const started = new Set(
      [...implemented].filter(member => member.includes('.')).map(member => member.split('.')[0]!)
    )

    const holes = surface.filter(
      member => started.has(member.split('.')[0]!) && !implemented.has(member) && !(member in NOT_YET)
    )

    expect(holes).toEqual([])
  })

  it('only shrinks', () => {
    expect(Object.keys(NOT_YET)).toHaveLength(NOT_YET_SIZE)
  })
})

describe('what each platform gets', () => {
  const EVERYWHERE = [
    'openExternal',
    'fetchLinkTitle',
    'readFileDataUrl',
    'dataUrlReadMax.get',
    'notify',
    'zoom.get',
    // The connection model: a phone has sources, sign-in and a roster too.
    'connections.list',
    'connections.onChanged',
    'getConnectionConfig',
    'applyConnectionConfig',
    'oauthLoginConnectionConfig',
    'cloud.login',
    'sshConfigHosts',
    'getAgentRoster',
    'getProfileRoutes',
    'revalidateConnection',
    'recycleBackend'
  ]

  const DESKTOP_ONLY = [
    'setKeepAwake',
    'revealPath',
    'setTranslucency',
    'glassSupported',
    'translucencySupported',
    // No folder picker, local backend or window theme on a phone.
    'settings.getDefaultProjectDir',
    'setNativeTheme'
  ]

  it('a desktop OS gets the everyday members and the desktop levers', async () => {
    const members = await bridgeSurface('linux')

    expect(members).toEqual(expect.arrayContaining([...EVERYWHERE, ...DESKTOP_ONLY]))
  })

  it('a phone gets the everyday members and none of the levers it has no use for', async () => {
    const members = await bridgeSurface('android')

    expect(members).toEqual(expect.arrayContaining(EVERYWHERE))
    expect(members.filter(member => DESKTOP_ONLY.includes(member))).toEqual([])
  })

  it('with no runtime, nothing Tauri-backed is offered — desktop’s web fallbacks apply', async () => {
    const members = await bridgeSurface('none')

    expect(members.filter(member => [...EVERYWHERE, ...DESKTOP_ONLY].includes(member))).toEqual([])
  })
})

describe('the profile namespace', () => {
  // Desktop feature-detects the namespace and then calls `set` unguarded
  // (`store/profile.ts`, `switchProfile`): a partial namespace is a TypeError.
  it('is whole on every platform, with or without a runtime', async () => {
    for (const platform of ['linux', 'android', 'none']) {
      const members = await bridgeSurface(platform)

      expect([platform, members.filter(member => member.startsWith('profile.')).sort()]).toEqual([
        platform,
        ['profile.get', 'profile.remember', 'profile.set']
      ])
    }
  })
})

describe('one handler per deep link, one per notification tap', () => {
  it('leaves desktop’s deep-link door shut, and its one caller optional-chains it', async () => {
    const members = new Set([...(await bridgeSurface('linux')), ...(await bridgeSurface('android'))])
    const hook = fs.readFileSync(path.join(process.cwd(), 'src/app/contrib/hooks/use-desktop-integrations.ts'), 'utf8')

    for (const member of ['onDeepLink', 'signalDeepLinkReady', 'onNotificationActivate', 'onNotificationAction']) {
      expect([member, members.has(member)]).toEqual([member, false])
      expect([member, hook.includes(`hermesDesktop?.${member}?.(`)]).toEqual([member, true])
    }

    // …because the router is armed for every window kind, desktop's root included.
    expect(fs.readFileSync(path.join(process.cwd(), 'src/app.tsx'), 'utf8')).toMatch(/^\s*startDeepLinkRouter\(\)$/m)
  })
})
