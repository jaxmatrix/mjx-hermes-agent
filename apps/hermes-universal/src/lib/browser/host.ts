import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { IS_TAURI } from '@/lib/platform'

/**
 * The ONE module that talks to `browser_*` and the ONE that subscribes to
 * `browser://…`.
 *
 * Everything above it — the tab store, the reader, the act engine, the console
 * ring, the occlusion arbiter — goes through these functions, so the arg casing
 * (camelCase on the wire, `snake_case` command names) and the
 * subscribe-before-open ordering are stated once instead of at eight call
 * sites.
 */

/** The one guest today. The tab names the SURFACE, not the page. */
export const BROWSER_GUEST_ID = 'browser'

export type BrowserHostKind = 'child-webview' | 'native-view' | 'none'

export interface BrowserCapabilities {
  platform: string
  host: BrowserHostKind
  isolatedStore: 'ephemeral' | 'own' | 'shared'
  history: 'engine' | 'estimated'
  gestures: boolean
  console: 'none' | 'poll' | 'push'
  devtools: boolean
  loadErrors: 'engine' | 'timeout'
  act: 'dom' | 'native-input'
  notes: string[]
}

export interface GuestBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface GuestState {
  id: string
  url: string
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
  historySource: 'engine' | 'estimated'
  visible: boolean
}

export type ReachNote = 'connection-gone' | 'forward-failed' | 'gateway-not-ssh' | 'no-session' | 'not-loopback'

export interface ReachResult {
  url: string
  leased: boolean
  localPort?: number
  note?: ReachNote
}

/** The structured error every `browser_*` command rejects with. */
export interface BrowserHostError {
  kind: string
  message: string
}

/** Tauri rejects with the serialised error object; anything else is a throw. */
export function browserErrorOf(error: unknown): BrowserHostError {
  if (error && typeof error === 'object' && 'kind' in error && 'message' in error) {
    return error as BrowserHostError
  }

  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

const UNSUPPORTED: BrowserCapabilities = {
  act: 'dom',
  console: 'none',
  devtools: false,
  gestures: false,
  history: 'estimated',
  host: 'none',
  isolatedStore: 'ephemeral',
  loadErrors: 'timeout',
  notes: ['This build is not running inside Tauri, so there is no guest webview host.'],
  platform: 'web'
}

export async function browserCapabilities(): Promise<BrowserCapabilities> {
  if (!IS_TAURI) {
    return UNSUPPORTED
  }

  try {
    return await invoke<BrowserCapabilities>('browser_capabilities')
  } catch (error) {
    return { ...UNSUPPORTED, notes: [browserErrorOf(error).message] }
  }
}

export function openGuest(url: string, bounds: GuestBounds, guestId = BROWSER_GUEST_ID): Promise<GuestState> {
  return invoke<GuestState>('browser_open', { bounds, guestId, url })
}

export function navigateGuest(url: string, guestId = BROWSER_GUEST_ID): Promise<GuestState> {
  return invoke<GuestState>('browser_navigate', { guestId, url })
}

export function guestBack(guestId = BROWSER_GUEST_ID): Promise<GuestState> {
  return invoke<GuestState>('browser_back', { guestId })
}

export function guestForward(guestId = BROWSER_GUEST_ID): Promise<GuestState> {
  return invoke<GuestState>('browser_forward', { guestId })
}

export function guestReload(guestId = BROWSER_GUEST_ID): Promise<GuestState> {
  return invoke<GuestState>('browser_reload', { guestId })
}

export function guestStop(guestId = BROWSER_GUEST_ID): Promise<GuestState> {
  return invoke<GuestState>('browser_stop', { guestId })
}

export function setGuestBounds(bounds: GuestBounds, guestId = BROWSER_GUEST_ID): Promise<void> {
  return invoke<void>('browser_set_bounds', { bounds, guestId })
}

/** Resolves to the RESULTING visibility, not the requested one (rule 9). */
export function setGuestVisible(visible: boolean, guestId = BROWSER_GUEST_ID): Promise<boolean> {
  return invoke<boolean>('browser_set_visible', { guestId, visible })
}

/**
 * The one eval door. Returns the JSON the engine produced, as a string.
 *
 * Not exported through the plugin SDK, deliberately: a plugin already runs with
 * the app's full authority, so exporting it would add no security and would
 * freeze the act engine's internals as a published contract.
 */
export function evalInGuest(script: string, timeoutMs?: number, guestId = BROWSER_GUEST_ID): Promise<string> {
  return invoke<string>('browser_eval', { guestId, script, timeoutMs })
}

export function clearGuestData(guestId = BROWSER_GUEST_ID): Promise<void> {
  return invoke<void>('browser_clear_data', { guestId })
}

/** Resolves to whether DevTools actually opened. */
export function openGuestDevtools(guestId = BROWSER_GUEST_ID): Promise<boolean> {
  return invoke<boolean>('browser_open_devtools', { guestId })
}

export function closeGuest(guestId = BROWSER_GUEST_ID): Promise<void> {
  return invoke<void>('browser_close', { guestId })
}

export function reachUrlNative(url: string, scopeKey: string): Promise<ReachResult> {
  return invoke<ReachResult>('browser_reach_url', { scopeKey, url })
}

/** `undefined` drops every scope — the gateway-switch door. */
export function resetReach(scopeKey?: string): Promise<number> {
  return invoke<number>('browser_reach_reset', { scopeKey: scopeKey ?? null })
}

export interface GuestSubscribers {
  nav?: (state: GuestState) => void
  load?: (event: { phase: 'finished' | 'started'; url: string }) => void
  error?: (event: { kind: 'engine' | 'timeout'; code?: number; description: string; url: string }) => void
  console?: (event: { entries: unknown[] }) => void
  closed?: (event: { reason: string }) => void
  /** The guest asked the host to do something — see the Rust nav guard. */
  command?: (event: { command: string }) => void
}

/**
 * Subscribe to every topic for one guest.
 *
 * MUST be awaited before `openGuest`, or the first `nav`/`load` is dropped —
 * the same subscribe-then-open rule `voice_open` and `ws_open` already state.
 */
export async function subscribeGuest(
  subscribers: GuestSubscribers,
  guestId = BROWSER_GUEST_ID
): Promise<() => void> {
  if (!IS_TAURI) {
    return () => {}
  }

  const topics: Array<[keyof GuestSubscribers, string]> = [
    ['nav', 'nav'],
    ['load', 'load'],
    ['error', 'error'],
    ['console', 'console'],
    ['closed', 'closed'],
    ['command', 'command']
  ]

  const unlisteners = await Promise.all(
    topics.map(async ([key, topic]): Promise<UnlistenFn> => {
      const handler = subscribers[key]

      if (!handler) {
        return () => {}
      }

      return listen(`browser://${guestId}/${topic}`, event => {
        ;(handler as (payload: unknown) => void)(event.payload)
      })
    })
  )

  return () => unlisteners.forEach(off => off())
}
