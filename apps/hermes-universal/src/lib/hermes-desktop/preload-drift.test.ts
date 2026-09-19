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

  // -- batch 2: connections, config, sign-in ------------------------------------
  connections: 'batch 2: the registry namespace over connections_*',
  cloud: 'batch 2: portal_* sign-in and discovery',
  'profile.set':
    'batch 2: relaunch-under-profile has no analogue on the unified server; decide with the connection settings',
  getConnectionConfig: 'batch 2: connection settings',
  saveConnectionConfig: 'batch 2: connection settings',
  applyConnectionConfig: 'batch 2: connection settings',
  testConnectionConfig: 'batch 2: connection settings',
  probeConnectionConfig: 'batch 2: connection settings',
  oauthLoginConnectionConfig: 'batch 2: oauth_login',
  oauthLogoutConnectionConfig: 'batch 2: oauth_logout',
  getSecretStorageEncryption: 'batch 2: secrets_status',
  setSecretStorageEncryption: 'batch 2: secrets_*',
  sshConfigHosts: 'batch 2: ssh_list_config_hosts',
  sshResolveHost: 'batch 2: ssh_resolve_host',
  revalidateConnection: 'batch 2: connection lifecycle',
  setActiveConnectionRoute: 'batch 2: connection lifecycle',
  getProfileRoutes: 'batch 2: plugin profile routes',
  getAgentRoster: 'batch 2: connections_roster',
  getPoolLimits: 'batch 2: no backend pool on the unified server — decide absent-for-good or an "unsupported" shape',
  setPoolLimits: 'batch 2: no backend pool on the unified server',
  recycleBackend: 'batch 2: local_backend_restart',
  saveGatewayFile:
    'batch 2: a connection-scoped download over store/downloads.ts (download_file is scoped by media_set_target today)',
  mcpOauth: 'batch 2: a loopback listener for MCP OAuth',
  settings: 'batch 2: default project directory',

  // -- batch 2–3: windows, updates, themes, git, terminal, satellites -----------
  openSessionWindow: 'batch 2: open_session_window',
  openSessionInTerminal: 'batch 2: open_in_terminal',
  openWindow: 'batch 2: open_instance_window',
  openBrowserWindow: 'batch 3: the in-app browser’s pop-out',
  onBrowserPopoutClosed: 'batch 3: the in-app browser’s pop-out',
  onWindowStateChanged: 'batch 2: fullscreen / maximize state',
  setTitleBarTheme: 'batch 2: no OS titlebar on a frameless window — decide absent-for-good',
  setNativeTheme: 'batch 2: native theme hint',
  setDisableF12: 'batch 2: devtools policy',
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
  skipIntro: 'batch 3: launch flag — get_app_flag is async, and this is read synchronously'
}

/** Lower it when an entry leaves. It does not go up without a decision. */
const NOT_YET_SIZE = 110

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
  const EVERYWHERE = ['openExternal', 'fetchLinkTitle', 'readFileDataUrl', 'dataUrlReadMax.get', 'notify', 'zoom.get']
  const DESKTOP_ONLY = ['setKeepAwake', 'revealPath', 'setTranslucency', 'glassSupported', 'translucencySupported']

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
