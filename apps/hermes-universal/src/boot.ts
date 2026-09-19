/**
 * Universal's boot levers: what desktop's entry has no place for.
 *
 * `main.tsx` is desktop's file plus one call to `bootUniversal()`, so everything
 * a Tauri shell or a phone needs at launch lives here — and a resync of the
 * entry never has to merge it. Nothing here dials: desktop's boot hook
 * (`app/gateway/hooks/use-gateway-boot.ts`) owns the connection, through the
 * `hermesDesktop` bridge.
 */

// Side-effect import: every WebView must be listening for another WebView's
// gateway switch before its fold dials, or it keeps serving the gateway the user
// just moved off.
import './store/gateway-switch-sync'

import { IS_MOBILE, IS_TAURI } from './lib/platform'
import { initSafeAreaInsets } from './lib/safe-area'
import { persistSessionCookies, sessionCookiesRestored } from './lib/session-persist'
import { installObservability } from './observability/install'
import { holdForLaunch } from './store/active-connection'
import { initAppLifecycle, onBackground } from './store/app-lifecycle'
import { openTunnelPage } from './store/connection-tunnels'
import { restoreLaunchConnection, startConnectionsWatcher } from './store/connections'
import { ownsPersistedAppState } from './store/windows'

let booted = false

/**
 * One lever. A throw is reported and the rest go on — and so does the render:
 * `main.tsx` calls this module before `createRoot`, so a lever that threw past
 * here was a white screen.
 *
 * Reported by name and error KIND, never its text: levers reach Rust, whose
 * messages can name the gateway.
 */
function lever(name: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    console.error(`[boot] ${name} failed`, error instanceof Error ? error.name : typeof error)
  }
}

/** Once, from `main.tsx`, before the first render. The order is load-bearing. */
export function bootUniversal(): void {
  if (booted) {
    return
  }

  booted = true

  // Span tracing FIRST, so boot-time work falls inside the trace rather than
  // before it. Recording is off by default, so this is a no-op until asked for.
  lever('observability', () => installObservability())

  // Foreground/background, before anything that wants the first edge after
  // launch: the bridge's `onPowerResume` is this signal on a phone, where the
  // socket always dies while the app is away.
  lever('app lifecycle', () => {
    initAppLifecycle()
    // Going away snapshots the cookie jar while there is still a process to do
    // it — the rotation it holds is what the next cold launch needs.
    onBackground(() => void persistSessionCookies())
  })

  // Rehydrate the persisted gateway/cloud session into the Rust cookie jar.
  // Started here and awaited by the bridge ahead of every dial and REST call,
  // so a cookie-backed login re-dials without an interactive sign-in.
  lever('session cookies', () => void sessionCookiesRestored())

  // The page declares its start to the tunnel book before anything can acquire
  // (MJXHRM-592): a reloaded WebView ends the previous page's holds here, not
  // at its first acquire, which may never come.
  lever('tunnel page', () => openTunnelPage())

  // Every window follows the registry: a rename made in a settings Activity has
  // to reach the shell painting the source chip.
  lever('connections watcher', () => void startConnectionsWatcher())

  // …and every window publishes where it launches, because each runs its own
  // fold over its own bridge: the owner of the app's persisted state seeds the
  // registry and honours the launch mode; a tile, an activity screen or the HUD
  // opens onto the source the app is on. No window's URL names a connection, and
  // a switch made later reaches them all as a broadcast. Identity only — the
  // bridge holds its first answer for this, and the boot hook does the dialling.
  if (IS_TAURI) {
    lever('launch connection', () => holdForLaunch(restoreLaunchConnection(ownsPersistedAppState())))
  }

  // Deterministic `--safe-area-inset-*` vars and `html.is-mobile`, both before
  // the first paint: env() reports 0 for a few frames (see lib/safe-area), and
  // every mobile-only rule in styles.css keys off the class.
  lever('safe area', () => initSafeAreaInsets())
  document.documentElement.classList.toggle('is-mobile', IS_MOBILE)
}
