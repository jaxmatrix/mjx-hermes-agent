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
const { $rightRailActiveTabId, selectRightRailTab } = await import('./layout')

const { $browserPages, $previewTabs, closeRightRail, closeRightRailTab, newBrowserTab, openPreview } =
  await import('./preview')

const {
  $browserGuestTabId,
  $browserState,
  __resetBrowserStore,
  applyGuestState,
  closeInAppBrowser,
  forgetBrowserForGatewaySwitch,
  markGuestOpen,
  openInAppBrowser,
  reachUrl,
  takePendingNavigation,
  toggleInAppBrowser
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

const guestAt = (url: string, title = '') => ({
  canBack: false,
  canForward: false,
  historySource: 'estimated' as const,
  id: 'browser',
  loading: false,
  title,
  url,
  visible: true
})

const browserTabs = () => $previewTabs.get().filter(tab => tab.target.kind === 'url')

const FILE = { kind: 'file', label: 'a.ts', source: '/repo/a.ts', url: 'file:///repo/a.ts' } as const

beforeEach(() => {
  // Sweeping the rail takes a bound guest down with it, so the mocks are
  // cleared AFTER — or the last test's teardown counts against this one.
  closeRightRail()
  __resetBrowserStore()
  vi.clearAllMocks()
  $browserPages.set({})
  $activeConnection.set(null)
  host.browserCapabilities.mockResolvedValue(CAPABLE)
  host.reachUrlNative.mockResolvedValue({ leased: false, url: 'unused' })
  host.navigateGuest.mockImplementation((url: string) => Promise.resolve(guestAt(url)))
})

describe('the browser tab', () => {
  it('navigates the Browser you have — a second url does not add a tab', async () => {
    // Desktop's rule, and the reason a chatty agent cannot stack twelve tabs
    // onto the rail: a url opens in the Browser in front, else the last one
    // used. New tabs are something the USER asks for (the strip's "+").
    await openInAppBrowser('https://example.com')
    await openInAppBrowser('https://other.example')

    expect(browserTabs()).toHaveLength(1)
    expect(browserTabs()[0].target.url).toBe('https://other.example/')
    expect($rightRailActiveTabId.get()).toBe(browserTabs()[0].id)
    expect($browserGuestTabId.get()).toBe(browserTabs()[0].id)
  })

  it('re-fronts rather than duplicating when another tab is selected', async () => {
    openPreview(FILE)

    await openInAppBrowser('https://example.com')

    expect($previewTabs.get()).toHaveLength(2)
    expect($rightRailActiveTabId.get()).toBe(browserTabs()[0].id)
  })

  it('refuses an address the policy would refuse, and says so by returning false', async () => {
    expect(await openInAppBrowser('file:///etc/passwd')).toBe(false)
    expect($previewTabs.get()).toHaveLength(0)
  })

  it('refuses when the platform reports no host', async () => {
    host.browserCapabilities.mockResolvedValue({ ...CAPABLE, host: 'none' })

    expect(await openInAppBrowser('https://example.com')).toBe(false)
    expect($previewTabs.get()).toHaveLength(0)

    await toggleInAppBrowser()

    expect($previewTabs.get()).toHaveLength(0)
  })

  it('shows — and keeps — the address the USER asked for, not the tunnel behind it', async () => {
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
    // The tab is persisted; a forwarded port is not an address anyone can come
    // back to. The guest gets the tunnel, and only the guest.
    expect(browserTabs()[0].target.url).toBe('http://localhost:5173/')
    expect(takePendingNavigation()).toBe('http://127.0.0.1:41000/')
  })

  it('closes EVERY Browser and drops every lease on a gateway switch, and nothing else', async () => {
    openPreview(FILE)
    await openInAppBrowser('https://example.com')
    newBrowserTab()

    expect(browserTabs()).toHaveLength(2)

    forgetBrowserForGatewaySwitch()

    expect(host.resetReach).toHaveBeenCalledWith()
    expect(browserTabs()).toEqual([])
    expect($previewTabs.get().map(tab => tab.target)).toEqual([FILE])
    expect($browserState.get().url).toBe('')
    expect($browserGuestTabId.get()).toBeNull()
  })

  it('kills the GUEST on a gateway switch even after the tabs were already swept', async () => {
    // A wipe door can sweep the rail first, so a tab-guarded teardown would be a
    // no-op here and leave a live webview still showing the old machine's page.
    await openInAppBrowser('https://example.com')
    closeRightRail()
    host.closeGuest.mockClear()

    forgetBrowserForGatewaySwitch()

    expect(host.closeGuest).toHaveBeenCalled()
  })

  it('closing when no browser tab is open is a no-op, not a stray guest close', () => {
    closeInAppBrowser()

    expect(host.closeGuest).not.toHaveBeenCalled()
  })

  it('tells the strip what the Browser is showing', async () => {
    await openInAppBrowser('https://example.com')
    applyGuestState(guestAt('https://example.com/docs', 'Docs'))

    expect($browserPages.get()[browserTabs()[0].id]).toEqual({ title: 'Docs', url: 'https://example.com/docs' })
  })
})

// ONE LIVE GUEST (see the module note). Desktop's tab model allows many Browsers;
// this layer drives one page, so the rest are locations.
describe('one guest, many Browsers', () => {
  it('hands the guest to the Browser the user focuses, keeping the page it leaves', async () => {
    await openInAppBrowser('https://example.com')
    markGuestOpen(true)
    applyGuestState(guestAt('https://example.com/docs', 'Docs'))

    const first = browserTabs()[0].id

    // The strip's "+": another Browser, in front. It did not come through this
    // module, and the guest follows it anyway.
    newBrowserTab()

    const second = browserTabs()[1].id

    expect($browserGuestTabId.get()).toBe(second)
    // Desktop's hand-off door: where the guest WAS is written onto the tab it left.
    expect(browserTabs()[0].target).toMatchObject({ label: 'Docs', url: 'https://example.com/docs' })
    await vi.waitFor(() => expect(host.navigateGuest).toHaveBeenLastCalledWith('about:blank'))

    selectRightRailTab(first)

    expect($browserGuestTabId.get()).toBe(first)
    await vi.waitFor(() => expect(host.navigateGuest).toHaveBeenLastCalledWith('https://example.com/docs'))
    expect($browserState.get().url).toBe('https://example.com/docs')
    // Still two tabs, still one guest: nothing was opened for the second one.
    expect(browserTabs()).toHaveLength(2)
  })

  it('leaves the guest where it is while a file tab is in front', async () => {
    await openInAppBrowser('https://example.com')

    const browser = browserTabs()[0].id

    openPreview(FILE)

    expect($browserGuestTabId.get()).toBe(browser)
    expect(host.closeGuest).not.toHaveBeenCalled()
  })

  it('takes the guest down with its Browser, whichever door closed it', async () => {
    await openInAppBrowser('https://example.com')
    markGuestOpen(true)

    // Desktop's strip / ⌘W, not `closeInAppBrowser`.
    closeRightRailTab(browserTabs()[0].id)

    expect(host.closeGuest).toHaveBeenCalledTimes(1)
    expect($browserGuestTabId.get()).toBeNull()
    expect($browserState.get().url).toBe('')
  })

  it('a late reach cannot navigate a guest that has moved on', async () => {
    await openInAppBrowser('https://example.com')
    markGuestOpen(true)

    const first = browserTabs()[0].id
    let release: (value: { leased: boolean; url: string }) => void = () => undefined

    $activeConnection.set({
      connection: {} as never,
      connectionId: 'box-a',
      dialConnectionId: 'box-a',
      kind: 'ssh',
      label: 'box-a',
      profile: 'work',
      scopeKey: 'conn:box-a::work'
    })
    host.reachUrlNative.mockReturnValueOnce(new Promise(resolve => (release = resolve)))
    host.reachUrlNative.mockResolvedValue({ leased: false, url: 'https://example.com/' })

    // The second Browser's reach is still out when the user goes back to the first.
    newBrowserTab()
    await vi.waitFor(() => expect(host.reachUrlNative).toHaveBeenCalledTimes(1))
    selectRightRailTab(first)
    await vi.waitFor(() => expect(host.navigateGuest).toHaveBeenLastCalledWith('https://example.com/'))

    release({ leased: false, url: 'about:blank' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(host.navigateGuest).not.toHaveBeenCalledWith('about:blank')
    expect($browserState.get().url).toBe('https://example.com/')
  })

  it('⌘⇧L closes the Browser in front, and otherwise re-fronts the one you have', async () => {
    await openInAppBrowser('https://example.com')

    const browser = browserTabs()[0].id

    openPreview(FILE)
    await toggleInAppBrowser()

    expect($rightRailActiveTabId.get()).toBe(browser)
    expect(browserTabs()).toHaveLength(1)

    await toggleInAppBrowser()

    expect(browserTabs()).toEqual([])
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
