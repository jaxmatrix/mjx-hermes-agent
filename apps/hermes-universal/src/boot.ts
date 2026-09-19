/**
 * Universal's boot levers: what desktop's entry has no place for.
 *
 * `main.tsx` is desktop's file plus one call to `bootUniversal()`, so everything
 * a Tauri shell or a phone needs at launch lives here — and a resync of the
 * entry never has to merge it. Nothing here dials: desktop's boot hook
 * (`app/gateway/hooks/use-gateway-boot.ts`) owns the connection, through the
 * `hermesDesktop` bridge.
 */

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
 * Reported with its stack: what is caught here is a SYNCHRONOUS throw, which is
 * this app's own code and cannot carry Rust's text (which can name a gateway).
 * Checked per lever — tracing, lifecycle and safe area touch the DOM alone; the
 * tunnel page, the watcher, the cookie restore and the launch reach Rust only
 * through a promise, whose rejection each handles itself and never lands here.
 * A lever that could throw a URL synchronously must report its name alone.
 */
function lever(name: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    console.error(`[boot] ${name} failed`, error instanceof Error ? (error.stack ?? error.name) : typeof error)
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
  lever('app lifecycle', () => initAppLifecycle())

  // Going away snapshots the cookie jar while there is still a process to do
  // it — the rotation it holds is what the next cold launch needs. A lever of
  // its own: the subscription needs nothing from the install above, so a failed
  // install is reported there and does not also, silently, cost this.
  lever('cookie snapshot', () => void onBackground(() => void persistSessionCookies()))

  // Rehydrate the persisted gateway/cloud session into the Rust cookie jar.
  // Started here and awaited by the bridge ahead of every dial and REST call,
  // so a cookie-backed login re-dials without an interactive sign-in.
  lever('session cookies', () => void sessionCookiesRestored())

  // The page declares its start to the tunnel book before anything can acquire
  // (MJXHRM-592): a reloaded WebView ends the previous page's holds here, not
  // at its first acquire, which may never come.
  lever('tunnel page', () => openTunnelPage())

  // Every window follows Rust: the registry (a rename made in a settings
  // Activity has to reach the shell painting the source chip) and the source the
  // app is on. Before the launch below, which waits for it to be listening — or
  // a window keeps serving the gateway the user just moved off.
  lever('connections watcher', () => void startConnectionsWatcher())

  // …and every window publishes the source the app is on, because each runs its
  // own fold over its own bridge. None decides it: Rust decides launch once per
  // process, and a tile, an instance window, an activity screen or the HUD reads
  // the same answer as the main window (the owner of the app's persisted state
  // only seeds the registry first). A switch made later reaches them all as
  // Rust's announcement. Identity only — the bridge holds its first answer for
  // this, and the boot hook does the dialling.
  if (IS_TAURI) {
    lever('launch connection', () => holdForLaunch(restoreLaunchConnection(ownsPersistedAppState())))
  }

  // Deterministic `--safe-area-inset-*` vars and `html.is-mobile`, both before
  // the first paint: env() reports 0 for a few frames (see lib/safe-area), and
  // every mobile-only rule in styles.css keys off the class.
  lever('safe area', () => initSafeAreaInsets())
  document.documentElement.classList.toggle('is-mobile', IS_MOBILE)
}
