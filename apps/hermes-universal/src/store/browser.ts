import { normalizeBrowserAddress } from '@/lib/browser-address'
import {
  browserCapabilities,
  type BrowserCapabilities,
  browserErrorOf,
  closeGuest,
  guestBack,
  guestForward,
  guestReload,
  type GuestState,
  guestStop,
  navigateGuest,
  type ReachNote,
  reachUrlNative,
  resetReach
} from '@/lib/browser/host'
import { hostPathLabel } from '@/lib/external-link'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { $activeConnection } from '@/store/active-connection'
import { atom, computed } from '@/store/atom'
import { isLatched } from '@/store/connection-latches'
import { $rightRailActiveTabId } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import {
  $previewTabs,
  closeRightRailTab,
  commitBrowserTabLocation,
  forgetBrowserPage,
  noteBrowserPage,
  openBrowserTab,
  openPreview,
  type PreviewTab
} from '@/store/preview'
import { ownsPersistedAppState } from '@/store/windows'

/**
 * The in-app browser's live page state, on desktop's tab model.
 *
 * The TABS are desktop's (`store/preview`): a Browser is a url-kind `PreviewTab`
 * — a vessel you navigate, minted by `openPreview` / the strip's "+", mirrored
 * into the layout tree by `preview-tile` — so it is draggable, splittable and
 * ⌘W-closable with no pane engine of its own. This module never edits the tab
 * list except through desktop's own doors (`openPreview`, `closeRightRailTab`,
 * `commitBrowserTabLocation`).
 *
 * The PAGE is a native guest webview owned by Rust; nothing here draws it, and
 * everything here is about telling Rust where to go and what the bar should say.
 *
 * ONE LIVE GUEST. Desktop builds a `<webview>` per url tab. This layer drives a
 * single guest (`BROWSER_GUEST_ID`): `$browserState`, the console, the reader
 * and the actor are all one page's worth. So the invariant is:
 *
 *   - the guest is bound to at most one url tab, `$browserGuestTabId`;
 *   - that is the FOCUSED url tab — focusing another Browser hands the guest
 *     over: the tab it leaves gets its live location committed onto its target
 *     (`commitBrowserTabLocation`, desktop's hand-off door), and the guest
 *     navigates to the location the tab it joins was keeping;
 *   - every other url tab is only a location. It holds no page, no history and
 *     no lease, and says nothing to the strip until the guest comes back;
 *   - a bound tab that leaves `$previewTabs` by ANY door takes the guest with it.
 *
 * Rust keys its guests by id and could hold several; the limit is here, and
 * lifting it means per-tab state in this module, not a second tab model.
 */

const isBrowserTab = (tab: PreviewTab): boolean => tab.target.kind === 'url'

function focusedBrowserTab(): null | PreviewTab {
  const tab = $previewTabs.get().find(item => item.id === $rightRailActiveTabId.get())

  return tab && isBrowserTab(tab) ? tab : null
}

/**
 * The url tab the one live guest is bound to. Null: no Browser has the guest.
 *
 * A Browser restored IN FRONT starts bound but not loaded: the pane opens the
 * guest blank and offers the page back (see `$browserRestoredTab`) instead of
 * paying for it at launch.
 */
export const $browserGuestTabId = atom<null | string>(focusedBrowserTab()?.id ?? null)

export interface BrowserPageState {
  url: string
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
  historySource: 'engine' | 'estimated'
  /** From the last `browser://…/error`; cleared when the next load starts. */
  error: null | { kind: 'engine' | 'timeout'; code?: number; description: string; url: string }
  /** The reach outcome for the CURRENT address — drives the loopback explainer. */
  reach: null | { leased: boolean; localPort?: number; note?: ReachNote }
}

export const EMPTY_BROWSER_STATE: BrowserPageState = {
  canBack: false,
  canForward: false,
  error: null,
  historySource: 'estimated',
  loading: false,
  reach: null,
  title: '',
  url: ''
}

export const $browserState = atom<BrowserPageState>({ ...EMPTY_BROWSER_STATE })
export const $browserCapabilities = atom<BrowserCapabilities | null>(null)

/**
 * True only when the host reported a real guest. READ THIS, never `IS_DESKTOP`:
 * a desktop build whose `add_child` was refused has no browser, and a phone
 * with the native plugin does (rule 10).
 */
export const $browserSupported = computed($browserCapabilities, caps => !!caps && caps.host !== 'none')

// --- persisted preferences -------------------------------------------------

/**
 * The restored tab is remembered but NOT re-navigated (see `$resumeUrl`). A
 * restored URL can be an authenticated page, a paywall or a 20 MB SPA, and
 * paying that on every launch — on a phone, in cellular bytes — is a cost
 * nobody asked for. Desktop reopens it; this is a deliberate divergence.
 */
interface PersistedTab {
  url: string
  title: string
}

const MAX_PERSISTED_URL = 2048

const tabCodec = Codecs.json<null | PersistedTab>(raw => {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const value = raw as Record<string, unknown>
  const url = typeof value.url === 'string' ? value.url.slice(0, MAX_PERSISTED_URL) : ''

  // An older or forged blob must not be able to navigate the guest anywhere
  // the policy would refuse, so the URL is re-normalised on the way IN.
  const safe = normalizeBrowserAddress(url)

  return safe ? { title: typeof value.title === 'string' ? value.title.slice(0, 200) : '', url: safe } : null
})

export const $browserRestoredTab = persistentAtom<null | PersistedTab>('hermes.browser.tab.v1', null, tabCodec)

/**
 * Whether an ordinary web link opens in the pane.
 *
 * Default `true` on desktop and `false` on mobile: the phone's OS browser has
 * the user's logins and password manager, and an in-app browser that does not
 * is a downgrade for most links.
 */
export const $openLinksInApp = persistentAtom('hermes.browser.openLinksInApp', !matchesCoarsePointer(), Codecs.bool)

export const $browserConsoleOpen = persistentAtom('hermes.browser.consoleOpen', false, Codecs.bool)

// There is deliberately no `hermes.browser.devtoolsOpen`. Tauri exposes no
// `is_devtools_open` for a child webview, so a persisted flag would be a
// remembered REQUEST rather than a remembered state — and restoring it would
// re-open the inspector over a page the user had not asked to inspect.

function matchesCoarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

// --- capabilities ----------------------------------------------------------

let capabilitiesProbe: null | Promise<BrowserCapabilities> = null

/**
 * Ask once, cache forever. Deliberately NOT called at cold start: it is one IPC
 * round-trip that nothing on the first paint needs.
 */
export function ensureBrowserCapabilities(): Promise<BrowserCapabilities> {
  capabilitiesProbe ??= browserCapabilities().then(caps => {
    $browserCapabilities.set(caps)

    return caps
  })

  return capabilitiesProbe
}

// --- reach -----------------------------------------------------------------

export interface ReachOutcome {
  url: string
  leased: boolean
  localPort?: number
  note?: ReachNote
}

/**
 * Resolve a URL against the SSH forward lease.
 *
 * EVERY failure path returns the ORIGINAL url — callers must not read an
 * unchanged url as failure. The `note` is what makes "unchanged because it was
 * never loopback" distinguishable from "unchanged because the forward failed",
 * which is the difference the pane's explainer turns on.
 */
export async function reachUrl(url: string): Promise<ReachOutcome> {
  const active = $activeConnection.get()

  if (!active || active.kind !== 'ssh') {
    return { leased: false, note: 'gateway-not-ssh', url }
  }

  // 446: never lease against a source we have already latched as dead. The
  // forward would open against a session that is on its way out.
  if (isLatched(active.connectionId)) {
    return { leased: false, note: 'no-session', url }
  }

  try {
    // The session's own scope: one per SSH connection, whatever the profile.
    return await reachUrlNative(url, active.connection.sshScope ?? active.scopeKey)
  } catch {
    return { leased: false, note: 'forward-failed', url }
  }
}

/**
 * Drop every forward lease and close the browser tab.
 *
 * Called on both gateway-switch doors: a browsed loopback URL names the OLD
 * machine, and a lease into it is a tunnel a new host must never inherit.
 */
export function forgetBrowserForGatewaySwitch(): void {
  void resetReach().catch(() => undefined)

  // EVERY Browser, not just the one holding the guest: a tab that is only a
  // location still names the old machine, and would be reached through the NEW
  // one's forward the moment it was focused.
  handingOver = true

  try {
    for (const tab of $previewTabs.get().filter(isBrowserTab)) {
      forgetBrowserPage(tab.id)
      closeRightRailTab(tab.id)
    }
  } finally {
    handingOver = false
  }

  // …and the guest UNCONDITIONALLY. A wipe door may already have swept the tabs
  // by the time it calls this, so a tab-guarded teardown would be a no-op there
  // and leave a live webview still showing the old machine's page.
  $browserRestoredTab.set(null)
  dropGuest()
}

/** End the live page: the guest, its state and its binding. */
function dropGuest(): void {
  navigationSeq += 1
  $browserGuestTabId.set(null)
  $browserState.set({ ...EMPTY_BROWSER_STATE })
  void closeGuest().catch(() => undefined)
  guestIsOpen = false
  pendingNavigation = null
}

// --- the tab ---------------------------------------------------------------

export function applyGuestState(state: GuestState): void {
  const previous = $browserState.get()

  $browserState.set({
    ...previous,
    canBack: state.canBack,
    canForward: state.canForward,
    historySource: state.historySource,
    loading: state.loading,
    title: state.title,
    url: state.url
  })

  if (ownsPersistedAppState() && state.url && state.url !== 'about:blank') {
    $browserRestoredTab.set({ title: state.title, url: state.url })
  }

  publishPage()
}

/**
 * Tell desktop's strip what the bound Browser is showing, so its tab renames
 * itself (`$browserPages`, read by `preview-tile`'s label and its "open in the
 * OS browser" row). NOT written into the tab's target: that is a hand-off, and
 * happens once, when the guest leaves the tab.
 */
function publishPage(): void {
  const tabId = $browserGuestTabId.get()
  const page = $browserState.get()

  if (tabId && page.url) {
    noteBrowserPage(tabId, { title: page.title, url: page.url })
  }
}

/**
 * Open a URL in the pane. The seam every other surface uses — a link click, the
 * ⌘K row, the keybind, 478's context-menu row, the agent's `preview.open`.
 *
 * Resolves `false` when the address was refused or there is no host, so a
 * caller can fall back to the OS browser instead of guessing.
 */
export async function openInAppBrowser(url: string, label?: string): Promise<boolean> {
  const address = normalizeBrowserAddress(url)

  if (!address) {
    return false
  }

  const caps = await ensureBrowserCapabilities()

  if (caps.host === 'none') {
    return false
  }

  const reach = await reachUrl(address)

  $browserState.set({
    ...EMPTY_BROWSER_STATE,
    loading: true,
    reach: { leased: reach.leased, localPort: reach.localPort, note: reach.note },
    // The bar shows the address the USER asked for, not the tunnel behind it.
    url: address
  })

  // Desktop's one way in. It navigates the Browser the user is looking at, else
  // the one they used last, else mints one — so a chatty agent cannot stack
  // twelve tabs onto the rail — and fronts it. The target carries the ORIGINAL
  // address: `127.0.0.1:41234` is our plumbing, means nothing to anyone reading
  // the strip, and is a port that will not exist after a relaunch.
  handingOver = true

  try {
    openPreview({ kind: 'url', label: label || hostPathLabel(address), source: address, url: address })
  } finally {
    handingOver = false
  }

  bindGuestTo($rightRailActiveTabId.get())
  publishPage()

  await loadInGuest(reach.url, address)

  return true
}

/**
 * Put `url` in the guest — now if it is live, else when the pane opens it.
 *
 * The pane mounts, measures its box and only THEN opens the guest: a guest built
 * before there is a rect flashes at 0×0 in the window's corner.
 */
async function loadInGuest(url: string, display: string): Promise<void> {
  pendingNavigation = url

  if (guestIsOpen) {
    // Consume the handoff: the guest is live, so the pane has nothing left to
    // open — and leaving it set would make a later remount load the page again.
    takePendingNavigation()
    await navigateBrowser(url, display)
  }
}

// --- one guest, many tabs --------------------------------------------------

/** True while THIS module is moving tabs, so `followFocus` does not answer a
 *  change its caller is about to finish itself. */
let handingOver = false

/** Bumped by every hand-over and teardown, so a reach that resolves late cannot
 *  navigate a guest that has since moved on. */
let navigationSeq = 0

/**
 * Bind the guest to `tabId`, committing the page it was showing onto the tab it
 * leaves. Binds FIRST: the commit writes `$previewTabs`, and `followFocus` must
 * find the new binding already in place when that lands.
 */
function bindGuestTo(tabId: null | string): void {
  const previous = $browserGuestTabId.get()

  if (!tabId || previous === tabId) {
    return
  }

  const page = $browserState.get()

  navigationSeq += 1
  $browserGuestTabId.set(tabId)

  if (previous && page.url) {
    commitBrowserTabLocation(previous, page.url, page.title || undefined)
  }
}

/** Hand the guest to a Browser the user focused: bind, then load what it kept. */
async function showBrowserTab(tab: PreviewTab): Promise<void> {
  const address = normalizeBrowserAddress(tab.target.url) ?? 'about:blank'

  bindGuestTo(tab.id)

  const seq = navigationSeq

  $browserState.set({ ...EMPTY_BROWSER_STATE, loading: guestIsOpen, url: address })

  // No host, no guest to load into — and no forward worth leasing for one.
  if ((await ensureBrowserCapabilities()).host === 'none' || seq !== navigationSeq) {
    return
  }

  const reach = await reachUrl(address)

  if (seq !== navigationSeq) {
    return
  }

  $browserState.set({
    ...$browserState.get(),
    reach: { leased: reach.leased, localPort: reach.localPort, note: reach.note }
  })

  await loadInGuest(reach.url, address)
}

/**
 * Keep the invariant whichever door moved a tab — desktop's strip, ⌘W, the "+",
 * a restore — since none of them comes through this module.
 */
function followFocus(): void {
  if (handingOver) {
    return
  }

  const tabs = $previewTabs.get()
  const bound = $browserGuestTabId.get()

  if (bound && !tabs.some(tab => tab.id === bound)) {
    dropGuest()
  }

  const focused = focusedBrowserTab()

  if (focused && focused.id !== $browserGuestTabId.get()) {
    void showBrowserTab(focused)
  }
}

$previewTabs.listen(followFocus)
$rightRailActiveTabId.listen(followFocus)

/**
 * The address the pane should load when it mounts, taken once.
 *
 * A module-level handoff rather than a prop because the opener and the pane are
 * connected by the layout tree, not by a parent-child render.
 */
let pendingNavigation: null | string = null
let guestIsOpen = false

export function takePendingNavigation(): null | string {
  const url = pendingNavigation
  pendingNavigation = null

  return url
}

export function markGuestOpen(open: boolean): void {
  guestIsOpen = open
}

/** Navigate the live guest. `display` is what the bar should show. */
export async function navigateBrowser(url: string, display?: string): Promise<void> {
  try {
    const state = await navigateGuest(url)

    applyGuestState(state)
    $browserState.set({ ...$browserState.get(), error: null, url: display ?? state.url })
    publishPage()
  } catch (error) {
    notifyError(browserErrorOf(error).message, 'Could not open that address')
  }
}

/** Normalise, reach and navigate — what the address bar's Enter does. */
export async function submitBrowserAddress(value: string): Promise<boolean> {
  const address = normalizeBrowserAddress(value)

  if (!address) {
    return false
  }

  const reach = await reachUrl(address)

  $browserState.set({
    ...$browserState.get(),
    error: null,
    reach: { leased: reach.leased, localPort: reach.localPort, note: reach.note }
  })

  await navigateBrowser(reach.url, address)

  return true
}

async function drive(command: () => Promise<GuestState>): Promise<void> {
  try {
    applyGuestState(await command())
  } catch (error) {
    notifyError(browserErrorOf(error).message, 'The in-app browser did not answer')
  }
}

export const browserBack = (): Promise<void> => drive(guestBack)
export const browserForward = (): Promise<void> => drive(guestForward)
export const browserReload = (): Promise<void> => drive(guestReload)
export const browserStop = (): Promise<void> => drive(guestStop)

/**
 * ⌘⇧L: open the pane, or close it if it is already the tab in front.
 *
 * A fresh one lands on `about:blank`, where the address field is the invitation.
 */
export async function toggleInAppBrowser(): Promise<void> {
  const bound = $browserGuestTabId.get()

  if (bound && bound === $rightRailActiveTabId.get()) {
    closeInAppBrowser()

    return
  }

  if ((await ensureBrowserCapabilities()).host === 'none') {
    return
  }

  // Desktop's verb: re-front the Browser you have — keeping its page — else a
  // blank one. `followFocus` hands it the guest.
  openBrowserTab()
}

/** Close the Browser the guest is in. With no Browser open it is a no-op, not a
 *  stray guest close. */
export function closeInAppBrowser(): void {
  const tabId = $browserGuestTabId.get()

  if (!tabId) {
    return
  }

  // The same three steps desktop's tile closer takes (`preview-tile`), minus
  // its console buffer, which universal does not write.
  forgetBrowserPage(tabId)
  closeRightRailTab(tabId)

  // `followFocus` has already dropped the guest if the tab was there to close;
  // this covers a binding whose tab a wipe door swept first.
  if ($browserGuestTabId.get() === tabId) {
    dropGuest()
  }
}

/** Test seam: reset the module-level caches this store keeps. */
export function __resetBrowserStore(): void {
  capabilitiesProbe = null
  pendingNavigation = null
  guestIsOpen = false
  handingOver = false
  navigationSeq += 1
  $browserGuestTabId.set(null)
  $browserCapabilities.set(null)
  $browserState.set({ ...EMPTY_BROWSER_STATE })
}
