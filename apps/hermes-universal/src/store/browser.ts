import { normalizeBrowserAddress } from '@/lib/browser-address'
import {
  browserCapabilities,
  browserErrorOf,
  closeGuest,
  guestBack,
  guestForward,
  guestReload,
  guestStop,
  navigateGuest,
  reachUrlNative,
  resetReach,
  type BrowserCapabilities,
  type GuestState,
  type ReachNote
} from '@/lib/browser/host'
import { hostPathLabel } from '@/lib/external-link'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { $activeConnection } from '@/store/active-connection'
import { atom, computed } from '@/store/atom'
import { isLatched } from '@/store/connection-latches'
import { notifyError } from '@/store/notifications'
import {
  $previewTabs,
  BROWSER_TAB_PATH,
  closePreviewTab,
  isBrowserTab,
  openBrowserPreviewTab
} from '@/store/preview'
import { ownsPersistedAppState } from '@/store/windows'

/**
 * The in-app browser's tab and live page state.
 *
 * The TAB is a layout-tree tile like every other preview tab (`paneMirror`
 * already mirrors `$previewTabs`), so the browser is draggable, splittable,
 * detachable and ⌘W-closable with no new pane engine. The PAGE is a native
 * guest webview owned by Rust; nothing here draws it, and everything here is
 * about telling Rust where to put it and what the bar should say.
 */

export { BROWSER_TAB_PATH, isBrowserTab } from '@/store/preview'

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
export const $openLinksInApp = persistentAtom(
  'hermes.browser.openLinksInApp',
  !matchesCoarsePointer(),
  Codecs.bool
)

export const $browserConsoleOpen = persistentAtom('hermes.browser.consoleOpen', false, Codecs.bool)
export const $browserDevtoolsOpen = persistentAtom('hermes.browser.devtoolsOpen', false, Codecs.bool)

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
    return await reachUrlNative(url, active.scopeKey)
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
  closeInAppBrowser()
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

  // The tab is labelled by the ORIGINAL address: `127.0.0.1:41234` is our
  // plumbing and means nothing to anyone reading the strip.
  openBrowserPreviewTab(label || hostPathLabel(address))

  // The pane mounts, measures its box and only THEN opens the guest — a guest
  // built before there is a rect flashes at 0×0 in the window's corner.
  pendingNavigation = reach.url

  if (guestIsOpen) {
    await navigateBrowser(reach.url, address)
  }

  return true
}

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
 * A fresh one lands on `about:blank`, where the address field is the invitation
 * — rather than restoring the last page, which is a cost the user did not ask
 * for (see `$browserRestoredTab`).
 */
export async function toggleInAppBrowser(): Promise<void> {
  const open = $previewTabs.get().some(tab => isBrowserTab(tab.path))

  if (open) {
    closeInAppBrowser()

    return
  }

  await openInAppBrowser('about:blank')
}

export function closeInAppBrowser(): void {
  if (!$previewTabs.get().some(tab => isBrowserTab(tab.path))) {
    return
  }

  closePreviewTab(BROWSER_TAB_PATH)
  $browserState.set({ ...EMPTY_BROWSER_STATE })
  void closeGuest().catch(() => undefined)
  guestIsOpen = false
}

/** Test seam: reset the module-level caches this store keeps. */
export function __resetBrowserStore(): void {
  capabilitiesProbe = null
  pendingNavigation = null
  guestIsOpen = false
  $browserCapabilities.set(null)
  $browserState.set({ ...EMPTY_BROWSER_STATE })
}
