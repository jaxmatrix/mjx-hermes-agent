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
// gateway switch before it dials, or it keeps serving the gateway the user just
// moved off.
import './store/gateway-switch-sync'

import { IS_MOBILE, IS_TAURI } from './lib/platform'
import { initSafeAreaInsets } from './lib/safe-area'
import { persistSessionCookies, sessionCookiesRestored } from './lib/session-persist'
import { installObservability } from './observability/install'
import { initAppLifecycle, onBackground } from './store/app-lifecycle'
import { openTunnelPage } from './store/connection-tunnels'
import { loadConnectionsRegistry, startConnectionsWatcher } from './store/connections'
import { ownsPersistedAppState } from './store/windows'

let booted = false

/** Once, from `main.tsx`, before the first render. The order is load-bearing. */
export function bootUniversal(): void {
  if (booted) {
    return
  }

  booted = true

  // Span tracing FIRST, so boot-time work falls inside the trace rather than
  // before it. Recording is off by default, so this is a no-op until asked for.
  installObservability()

  // Foreground/background, before anything that wants the first edge after
  // launch: the bridge's `onPowerResume` is this signal on a phone, where the
  // socket always dies while the app is away.
  initAppLifecycle()
  // Going away snapshots the cookie jar while there is still a process to do
  // it — the rotation it holds is what the next cold launch needs.
  onBackground(() => void persistSessionCookies())

  // Rehydrate the persisted gateway/cloud session into the Rust cookie jar.
  // Started here and awaited by the bridge ahead of every dial and REST call,
  // so a cookie-backed login re-dials without an interactive sign-in.
  void sessionCookiesRestored()

  // The page declares its start to the tunnel book before anything can acquire
  // (MJXHRM-592): a reloaded WebView ends the previous page's holds here, not
  // at its first acquire, which may never come.
  openTunnelPage()

  // Every window follows the registry: a rename made in a settings Activity has
  // to reach the shell painting the source chip. Following is not restoring, so
  // only the window that owns the app's persisted state seeds and reads it.
  startConnectionsWatcher()

  if (IS_TAURI && ownsPersistedAppState()) {
    void loadConnectionsRegistry().catch(error => console.warn('[connections] registry unavailable', error))
  }

  // Deterministic `--safe-area-inset-*` vars and `html.is-mobile`, both before
  // the first paint: env() reports 0 for a few frames (see lib/safe-area), and
  // every mobile-only rule in styles.css keys off the class.
  initSafeAreaInsets()
  document.documentElement.classList.toggle('is-mobile', IS_MOBILE)
}
