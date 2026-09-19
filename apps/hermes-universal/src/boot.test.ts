import fs from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Universal's boot levers (`boot.ts`): the order they run in, the platform class
// the mobile stylesheet keys off, and the one thing the module must never do —
// reach the legacy store-level fold, whose dial desktop's boot hook replaced.

const { calls, platform, state } = vi.hoisted(() => ({
  calls: [] as string[],
  platform: { mobile: false, tauri: true },
  state: { background: null as (() => void) | null, held: null as null | Promise<unknown>, owner: true }
}))

const lever = (name: string) => vi.fn(() => void calls.push(name))

vi.mock('./store/gateway-switch-sync', () => ({}))
vi.mock('./lib/platform', () => ({
  get IS_MOBILE() {
    return platform.mobile
  },
  get IS_TAURI() {
    return platform.tauri
  }
}))
vi.mock('./lib/safe-area', () => ({ initSafeAreaInsets: lever('initSafeAreaInsets') }))
vi.mock('./lib/session-persist', () => ({
  persistSessionCookies: vi.fn(async () => void calls.push('persistSessionCookies')),
  sessionCookiesRestored: vi.fn(async () => void calls.push('sessionCookiesRestored'))
}))
vi.mock('./observability/install', () => ({ installObservability: lever('installObservability') }))
vi.mock('./store/active-connection', () => ({
  holdForLaunch: vi.fn((pending: Promise<unknown>) => {
    calls.push('holdForLaunch')
    state.held = pending
  })
}))
vi.mock('./store/app-lifecycle', () => ({
  initAppLifecycle: lever('initAppLifecycle'),
  onBackground: vi.fn((listener: () => void) => {
    calls.push('onBackground')
    state.background = listener
  })
}))
vi.mock('./store/connection-tunnels', () => ({ openTunnelPage: lever('openTunnelPage') }))
vi.mock('./store/connections', () => ({
  restoreLaunchConnection: vi.fn(async (owner: boolean) => void calls.push(`restoreLaunchConnection:${owner}`)),
  startConnectionsWatcher: lever('startConnectionsWatcher')
}))
vi.mock('./store/windows', () => ({ ownsPersistedAppState: () => state.owner }))

async function boot(): Promise<void> {
  vi.resetModules()
  ;(await import('./boot')).bootUniversal()
}

beforeEach(() => {
  calls.length = 0
  platform.mobile = false
  platform.tauri = true
  state.background = null
  state.held = null
  state.owner = true
  document.documentElement.classList.remove('is-mobile')
})

describe('bootUniversal', () => {
  it('runs the levers in order: tracing, lifecycle, cookies, tunnels, registry, launch, safe area', async () => {
    await boot()

    expect(calls).toEqual([
      'installObservability',
      'initAppLifecycle',
      'onBackground',
      'sessionCookiesRestored',
      'openTunnelPage',
      'startConnectionsWatcher',
      'restoreLaunchConnection:true',
      'holdForLaunch',
      'initSafeAreaInsets'
    ])
  })

  // The launch identity comes from Rust, so it cannot land before the first
  // effects run: the bridge's first answer waits on exactly this promise.
  it('holds the bridge on the launch identity it is publishing', async () => {
    await boot()

    await expect(state.held).resolves.toBeUndefined()
  })

  it('runs them once, however often the entry is evaluated', async () => {
    vi.resetModules()

    const { bootUniversal } = await import('./boot')

    bootUniversal()
    bootUniversal()

    expect(calls.filter(name => name === 'initAppLifecycle')).toHaveLength(1)
    expect(calls.filter(name => name === 'onBackground')).toHaveLength(1)
  })

  it('marks a phone for the mobile stylesheet, and only a phone', async () => {
    platform.mobile = true
    await boot()

    expect(document.documentElement.classList.contains('is-mobile')).toBe(true)

    platform.mobile = false
    await boot()

    expect(document.documentElement.classList.contains('is-mobile')).toBe(false)
  })

  it('snapshots the cookie jar when the app goes away', async () => {
    await boot()
    calls.length = 0

    state.background?.()

    expect(calls).toEqual(['persistSessionCookies'])
  })

  // Each window runs its own fold over its own bridge, so each publishes where
  // it launches; only the owner of app state seeds the registry doing it.
  it('publishes a launch identity in every window, as the owner only in the one that owns app state', async () => {
    state.owner = false
    await boot()

    expect(calls).toContain('startConnectionsWatcher')
    expect(calls).toContain('restoreLaunchConnection:false')
  })

  it('asks Rust for nothing outside a Tauri shell', async () => {
    platform.tauri = false
    await boot()

    expect(calls.filter(name => name.startsWith('restoreLaunchConnection'))).toEqual([])
    expect(calls).not.toContain('holdForLaunch')
  })
})

describe('the boot module', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/boot.ts'), 'utf8')

  const imports = [...source.matchAll(/^import (?:\{([^}]*)\} from )?'([^']+)'/gm)].map(match => ({
    names: (match[1] ?? '').split(',').map(name => name.trim()),
    // `./store/x` and `@/store/x` are one module.
    module: match[2].replace(/^(?:@\/|\.\/)/, '')
  }))

  it('imports no module of the legacy fold, so nothing here can re-arm its dial', () => {
    // Bare on purpose: `legacy-session-fold.test.ts` counts quoted `@/…` paths.
    const legacy = [
      'store/agent-read-requests',
      'store/connection',
      'store/event-router',
      'store/gateway-client',
      'store/gateway-restore',
      'store/session-key-states',
      'store/session-route-dispatch',
      'store/session-state-types'
    ]

    expect(imports.length).toBeGreaterThan(5)
    expect(imports.map(entry => entry.module).filter(module => legacy.includes(module))).toEqual([])
  })

  it('CALLS every lever it imports', () => {
    // `entry-graph.test.ts` pins this class for the entry (MJXHRM-448 D-01); the
    // levers live here now, so the same rule follows them.
    const levers = imports
      .flatMap(entry => entry.names)
      .filter(name => /^(?:init|install|open|start|load|restore|hold)[A-Z]/.test(name))

    expect(levers.length).toBeGreaterThan(5)

    for (const name of levers) {
      expect([name, source.includes(`${name}(`)]).toEqual([name, true])
    }
  })
})
