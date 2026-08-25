import { beforeEach, describe, expect, it, vi } from 'vitest'

const host = {
  browserCapabilities: vi.fn(),
  browserErrorOf: (error: unknown) => ({ kind: 'unknown', message: String(error) }),
  closeGuest: vi.fn(() => Promise.resolve()),
  guestBack: vi.fn(),
  guestForward: vi.fn(),
  guestReload: vi.fn(),
  guestStop: vi.fn(),
  navigateGuest: vi.fn(),
  reachUrlNative: vi.fn(),
  resetReach: vi.fn(() => Promise.resolve(0))
}

vi.mock('@/lib/browser/host', () => host)

const { $activeConnection } = await import('./active-connection')
const { $activePreviewPath, $previewTabs } = await import('./preview')
const {
  $browserState,
  BROWSER_TAB_PATH,
  __resetBrowserStore,
  closeInAppBrowser,
  forgetBrowserForGatewaySwitch,
  isBrowserTab,
  openInAppBrowser,
  reachUrl
} = await import('./browser')

const CAPABLE = {
  act: 'dom',
  console: 'poll',
  devtools: true,
  gestures: false,
  history: 'estimated',
  host: 'child-webview',
  isolatedStore: 'own',
  loadErrors: 'timeout',
  notes: [],
  platform: 'linux'
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetBrowserStore()
  $previewTabs.set([])
  $activePreviewPath.set(null)
  $activeConnection.set(null)
  host.browserCapabilities.mockResolvedValue(CAPABLE)
  host.reachUrlNative.mockResolvedValue({ leased: false, url: 'unused' })
})

describe('the browser tab', () => {
  it('is a SINGLETON — a second url swaps the target instead of adding a tab', async () => {
    // Making BROWSER_TAB_PATH a function of the url turns this red. The tab
    // names the SURFACE, not the page: a chatty agent must not be able to stack
    // twelve tabs onto the rail.
    await openInAppBrowser('https://example.com')
    await openInAppBrowser('https://other.example')

    const browserTabs = $previewTabs.get().filter(tab => isBrowserTab(tab.path))

    expect(browserTabs).toHaveLength(1)
    expect($activePreviewPath.get()).toBe(BROWSER_TAB_PATH)
  })

  it('re-fronts rather than duplicating when another tab is selected', async () => {
    $previewTabs.set([{ name: 'a.ts', path: '/repo/a.ts' }])
    $activePreviewPath.set('/repo/a.ts')

    await openInAppBrowser('https://example.com')

    expect($previewTabs.get()).toHaveLength(2)
    expect($activePreviewPath.get()).toBe(BROWSER_TAB_PATH)
  })

  it('refuses an address the policy would refuse, and says so by returning false', async () => {
    expect(await openInAppBrowser('file:///etc/passwd')).toBe(false)
    expect($previewTabs.get()).toHaveLength(0)
  })

  it('refuses when the platform reports no host', async () => {
    host.browserCapabilities.mockResolvedValue({ ...CAPABLE, host: 'none' })

    expect(await openInAppBrowser('https://example.com')).toBe(false)
    expect($previewTabs.get()).toHaveLength(0)
  })

  it('shows the address the USER asked for, not the tunnel behind it', async () => {
    $activeConnection.set({
      connection: {} as never,
      connectionId: 'box-a',
      dialConnectionId: 'box-a',
      kind: 'ssh',
      label: 'box-a',
      profile: 'work',
      scopeKey: 'conn:box-a::work'
    })
    host.reachUrlNative.mockResolvedValue({ leased: true, localPort: 41000, url: 'http://127.0.0.1:41000/' })

    await openInAppBrowser('http://localhost:5173')

    expect($browserState.get().url).toBe('http://localhost:5173/')
    expect($browserState.get().reach).toEqual({ leased: true, localPort: 41000, note: undefined })
  })

  it('closes the tab and drops every lease on a gateway switch', async () => {
    await openInAppBrowser('https://example.com')

    forgetBrowserForGatewaySwitch()

    expect(host.resetReach).toHaveBeenCalledWith()
    expect($previewTabs.get().some(tab => isBrowserTab(tab.path))).toBe(false)
    expect($browserState.get().url).toBe('')
  })

  it('kills the GUEST on a gateway switch even after the tab was already swept', async () => {
    // `wipeSessionListsForGatewaySwitch` runs `closeAllPreviewTabs()` first, so
    // a tab-guarded teardown would be a no-op here and leave a live webview
    // still showing the old machine's page.
    await openInAppBrowser('https://example.com')
    $previewTabs.set([])
    host.closeGuest.mockClear()

    forgetBrowserForGatewaySwitch()

    expect(host.closeGuest).toHaveBeenCalled()
  })

  it('closing when no browser tab is open is a no-op, not a stray guest close', () => {
    closeInAppBrowser()

    expect(host.closeGuest).not.toHaveBeenCalled()
  })
})

describe('reachUrl', () => {
  it('does not even ask Rust when the gateway is not SSH-backed', async () => {
    $activeConnection.set({
      connection: {} as never,
      connectionId: 'local',
      dialConnectionId: null,
      kind: 'url' as never,
      label: 'remote',
      profile: 'default',
      scopeKey: 'default'
    })

    expect(await reachUrl('http://localhost:5173')).toEqual({
      leased: false,
      note: 'gateway-not-ssh',
      url: 'http://localhost:5173'
    })
    expect(host.reachUrlNative).not.toHaveBeenCalled()
  })

  it('returns the ORIGINAL url when the native call fails', async () => {
    $activeConnection.set({
      connection: {} as never,
      connectionId: 'box-a',
      dialConnectionId: 'box-a',
      kind: 'ssh',
      label: 'box-a',
      profile: 'work',
      scopeKey: 'conn:box-a::work'
    })
    host.reachUrlNative.mockRejectedValue(new Error('no session'))

    // A caller must never read an unchanged url as failure — the note is what
    // carries the reason.
    expect(await reachUrl('http://localhost:5173')).toEqual({
      leased: false,
      note: 'forward-failed',
      url: 'http://localhost:5173'
    })
  })
})
