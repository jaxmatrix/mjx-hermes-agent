/**
 * Universal's boot levers: what desktop's entry has no place for.
 *
 * `main.tsx` is desktop's file plus one call to `bootUniversal()`, so everything
 * a Tauri shell or a phone needs at launch lives here — and a resync of the
 * entry never has to merge it. Nothing here dials: desktop's boot hook
 * (`app/gateway/hooks/use-gateway-boot.ts`) owns the connection, through the
 * `hermesDesktop` bridge.
 */

import { initTerminalFontSync } from './app/right-pane/terminal/terminal-font-sync'
import { hostsWindowChrome } from './lib/hermes-desktop/window-chrome'
import { warmKatexFonts } from './lib/katex-fonts'
import { installNativeContextMenuGuard } from './lib/native-context-menu'
import { IS_MOBILE, IS_TAURI } from './lib/platform'
import { initSafeAreaInsets } from './lib/safe-area'
import { persistSessionCookies, sessionCookiesRestored } from './lib/session-persist'
import { installObservability } from './observability/install'
import { holdForLaunch } from './store/active-connection'
import { initAppLifecycle, onBackground } from './store/app-lifecycle'
import { initBackgroundMode } from './store/background-mode'
import { initTray } from './store/tray'
import { openTunnelPage } from './store/connection-tunnels'
// Side effect: installs registryConnectionSource so host.agents() unions every
// logged-in gateway (Bot Mode multi-connection). Must load before plugins poll.
import './store/connection-plugin-source'
import { restoreLaunchConnection, startConnectionsWatcher } from './store/connections'
import { registerBuiltinDeepLinkRoutes } from './store/deep-link-builtins'
import { initDownloadSync } from './store/downloads'
import { installNotificationActivation } from './store/plugin-notify-handlers'
import { installWindowCloseGuard, ownsPersistedAppState, sweepStaleSurfaceGrants } from './store/windows'

let booted = false

/**
 * One lever. A throw is reported and the rest go on — and so does the render:
 * `main.tsx` calls this module before `createRoot`, so a lever that threw past
 * here was a white screen.
 *
 * Reported with its stack: what is caught here is a SYNCHRONOUS throw, which is
 * this app's own code and cannot carry Rust's text (which can name a gateway).
 * Checked per lever — tracing, lifecycle, the context-menu guard, the font warm
 * and safe area touch the DOM alone; the route table is a Map; the tunnel page,
 * the watcher, the cookie restore, the launch, the peer followers, the close
 * guard, background mode and the grant sweep reach Rust only through a promise,
 * whose rejection each handles itself and never lands here.
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

  // The core `hermes://` route table, before `App()` arms the router: a link
  // that cold-started the app is drained within milliseconds of the first paint.
  // Desktop answers the same links through `hermesDesktop.onDeepLink`, which
  // Electron's main process feeds; here Rust's buffer feeds universal's router.
  lever('deep link routes', () => registerBuiltinDeepLinkRoutes())

  // Cross-WebView followers. Every surface is its own WebView with its own copy
  // of each store, and a `storage` event does not cross them, so the writer
  // announces on the Tauri bus and the others adopt: a transfer started in one
  // window (its tray is in every other), and the terminal font, whose picker and
  // whose terminal are in different WebViews on Android.
  lever('download sync', () => initDownloadSync())
  lever('terminal font sync', () => initTerminalFontSync())

  // A notification outlives the process that sent it, so a tap can arrive cold:
  // the listener has to exist before any surface mounts. A no-op where the
  // platform has no activation (a desktop OS: the plugin has no click hook, so
  // the bridge leaves desktop's `onNotificationActivate` door absent too).
  lever('notification taps', () => installNotificationActivation())

  // Desktop's context menu never cancels the gesture (Electron shows no menu by
  // default); every Tauri webview would open its own beside it. First capture
  // listener on the window, which is what lets a dev build keep Inspect Element.
  if (hostsWindowChrome()) {
    lever('native context menu', () => void installNativeContextMenuGuard())

    // Universal's own pages (the Gateways page: SSH keys, tunnels, sign-in) join
    // desktop's workspace as contributions, since desktop's Settings cannot take
    // a section. Its own chunk, and late is fine: the route table, the palette
    // and the status bar all re-read the registry when it changes.
    lever('universal pages', () => {
      void import('./app/universal/pages')
        .then(pages => pages.registerUniversalPages())
        .catch(() => console.error('[boot] universal pages failed to load'))
    })
  }

  // Background mode (MJXHRM-436), in the window that owns the app's state only:
  // the close guard is the ONE `close-requested` listener this window gets — it
  // parks the first close behind the question `BackgroundCloseDialog` asks, and
  // otherwise ends in a Rust destroy or a hide — and registering one inside a
  // satellite would route its summoner's teardown through that satellite's JS.
  // The preference is re-mirrored because Rust's copy is process-local, and the
  // surface grants a dead process left in localStorage are swept.
  if (IS_TAURI && ownsPersistedAppState()) {
    lever('close guard', () => void installWindowCloseGuard())
    lever('background mode', () => initBackgroundMode())
    // Native tray labels/status — must stay out of background-mode (import cycle
    // with connection). Same owner window that owns the close guard.
    lever('tray', () => initTray())
    lever('surface grants', () => void sweepStaleSurfaceGrants())
  }

  // KaTeX's faces are `font-display: block`: the first equation of a session is
  // invisible until they land. Loaded at idle.
  lever('katex fonts', () => warmKatexFonts())

  // Deterministic `--safe-area-inset-*` vars and `html.is-mobile`, both before
  // the first paint: env() reports 0 for a few frames (see lib/safe-area), and
  // every mobile-only rule in styles.css keys off the class.
  lever('safe area', () => initSafeAreaInsets())
  document.documentElement.classList.toggle('is-mobile', IS_MOBILE)
}
