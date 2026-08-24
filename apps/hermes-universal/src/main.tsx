import 'katex/dist/katex.min.css'
import '@vscode/codicons/dist/codicon.css'
import './styles.css'
// Dev-only render counter. MUST precede the `react-dom` import below: react-dom
// captures the devtools hook at module init, so bippy has to install during THIS
// import's evaluation or every commit goes unseen. `vite.config.ts` aliases this
// specifier to a no-op module for non-dev builds, so neither the counter nor
// bippy reaches a shipped renderer.
import '@/debug/dev-only'
// Side-effect import: the hermes-media:// scheme handler lives in Rust and can't
// read the connection store, so this subscription pushes the gateway target in.
import './lib/media-stream'
// Side-effect import: the gateway event router must be listening before any
// connection is opened below. It self-registers, so this import IS the wiring.
import './store/event-router'
// Likewise: every WebView must be listening for another WebView's gateway switch
// before it dials, or it keeps serving the gateway the user just moved off.
import './store/gateway-switch-sync'
// Likewise again: `preview.read.request` / `window.read.request` park a running
// agent tool until the client answers, so the responder has to be listening
// before the first turn — see store/agent-read-requests.ts.
import './store/agent-read-requests'
// And its non-blocking sibling: `agent.terminal.output` arrives for every
// `terminal(background=true)` run whether or not any pane is mounted, and it is
// only ever sent once — nothing replays it — so the buffer has to exist before
// the first turn, not when the terminal pane happens to open.
import './store/agent-terminal-bridge'
// And the same for appearance: a skin or light/dark switch is global, but each
// WebView holds its own copy, so without this one every OTHER surface — a
// detached tile, the HUD, Quick Entry — keeps painting the appearance it booted
// with. Imported here (not from themes/index) so the wiring sits with the other
// cross-WebView listeners it mirrors.
import './themes/appearance-sync'
// And the terminal font, which has the same split with a sharper edge: on Android
// the picker lives in the Settings ACTIVITY while the terminal it re-faces lives
// in the chat one, and a detached tile window can host the terminal pane itself.
// Without this, changing the font only repainted whichever WebView the picker
// happened to be in.
import './app/right-pane/terminal/terminal-font-sync'
// And the transcript tail cache's lifecycle (MJXHRM-480): it hangs off the
// cold-open rekey and the turn-settle edge, both of which can fire before any
// chat surface has mounted — a tile restored into a layout, a session resumed by
// the HUD. This import IS the wiring.
import './store/transcript-cache-sync'
// And the core `hermes://` route table (MJXHRM-455). The registrations have to
// exist before `startDeepLinkRouter` drains Rust's cold-start buffer, and a
// link that cold-started the app is delivered within milliseconds of the first
// paint — so this import IS the wiring, exactly like the event router above.
import './store/deep-link-builtins'
// And the multi-connection registry's two hook fills (MJXHRM-446). Both are
// LAST-WRITER-WINS module side effects — MJXHRM-480 registers the
// single-gateway `SessionRequestRouter` and MJXHRM-455 the single-connection
// `PluginConnectionSource` at THEIR module load — so these two imports must be
// ordered AFTER them or the registry's implementations lose the race and every
// cross-source dispatch silently falls back to the ambient socket. The ordering
// is pinned by `main-boot-order.test.ts`.
import './store/connection-session-router'
import './store/connection-plugin-source'

import { installContextMenuBridge } from './app/context-menu/bridge'
import { initializeConnectionsRegistry, startConnectionsWatcher } from './store/connections'
import { installNotificationActivation } from './store/plugin-notify-handlers'
import { installTourDriver } from './store/tour-bridge'
import { installWindowBelowReader } from './store/window-below'

// And the reader that gives `window.read.request` something to say. Installed at
// boot, next to the responder it feeds, because the first turn can ask before
// any component has mounted (MJXHRM-213).
installWindowBelowReader()
// Same contract for `tour.request` (MJXHRM-473): the frame parks a blocked tool,
// so the driver has to be registered before the first turn rather than when some
// component happens to mount. driver.js itself stays off this path — the driver
// dynamic-imports `@/lib/tour` on the first request.
installTourDriver()
// And the notification tap listeners (MJXHRM-455). A tap can arrive while the
// app is cold — the notification outlives the process that sent it — so the
// listener has to exist before any surface mounts. A no-op on desktop, where the
// notification plugin registers no click hook at all.
installNotificationActivation()
// And the context menu's platform bridge (MJXHRM-478). Idempotent, and armed at
// boot rather than from the coordinator because Rust keys its per-engine
// handlers by WINDOW LABEL — a component that mounts, unmounts and remounts must
// not re-wire them. In v1 every platform answers "nothing suppressed, nothing
// promised", which is a true answer rather than a stub that lies.
installContextMenuBridge()

import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'

import { App } from './app'
import { RootErrorBoundary } from './components/error-boundary'
import { HapticsProvider } from './components/haptics-provider'
import { RootTooltipProvider } from './components/ui/tooltip'
import { I18nProvider } from './i18n'
import { warmKatexFonts } from './lib/katex-fonts'
import { IS_MOBILE } from './lib/platform'
import { queryClient } from './lib/query-client'
import { RouterNavBridge } from './lib/router-nav-bridge'
import { initSafeAreaInsets } from './lib/safe-area'
import { restoreSessionCookies } from './lib/session-persist'
import { installObservability } from './observability/install'
import { initBackgroundMode } from './store/background-mode'
import { resumePortalSignIn } from './store/cloud'
import { initDataUrlReadMax } from './store/data-url-read-max'
import { autoRestoreConnection } from './store/gateway-restore'
import { initKeepAwake } from './store/keep-awake'
import { initTranslucency } from './store/translucency'
import { initTray } from './store/tray'
import { installWindowCloseGuard, ownsPersistedAppState, sweepStaleSurfaceGrants } from './store/windows'
import { ThemeProvider } from './themes'
// Span tracing. Installed FIRST so boot-time work falls inside the trace rather
// than before it. Recording is off by default, so this is a no-op until someone
// asks for it — see src/observability/index.ts.
installObservability()

// Rehydrate a persisted gateway/cloud session into the Rust cookie jar (R2b), THEN
// auto-reconnect to the last-used gateway (D8). Cookies first so a cookie-backed
// login (ticket/oauth/cloud) re-dials without an interactive sign-in; the restore
// runs even if the cookie read fails (it degrades to a fresh sign-in). `$restoring`
// is seeded true synchronously from the saved target, so the connecting screen —
// not the picker — shows from the first paint while this resolves.
void restoreSessionCookies().finally(() => {
  void autoRestoreConnection()
})

// An Android Hermes Cloud sign-in comes back through a full page reload, and the
// marker it left has to be read by the boot rather than by whichever panel happens
// to mount — the statusbar gateway popover, one of the surfaces you can start the
// sign-in from, is gone by the time we get here. See store/cloud.ts.
void resumePortalSignIn()

// The keep-awake preference lives in the webview but the inhibitor lives in
// Rust and dies with the process, so a relaunch has to re-arm it — otherwise the
// toggle reads "on" while the machine is free to sleep. No-op off desktop.
initKeepAwake()

// Same shape, same reason: the attachment size cap is persisted in the webview
// but ENFORCED in Rust, whose copy is a plain atomic that boots at the default.
// Without this a device configured down to 2 MB would spend the whole session
// letting 16 MB through — the one number the guard exists to get right.
initDataUrlReadMax()

// The window's own translucency. The native lever dies with the process, so a
// persisted preference has to be re-asserted or a tuned window comes back
// opaque on every relaunch.
initTranslucency()

// Background mode (MJXHRM-436). Three pieces, all at boot:
//
//  • the close guard, which is the ONLY `tauri://close-requested` listener this
//    window gets. It used to be armed lazily by the first satellite summon, and
//    that was a latent bug on its own: Tauri's core prevents the close for any
//    window that has such a listener and the JS wrapper's fallback `destroy()`
//    is not in `capabilities/default.json`, so a window that had opened a
//    satellite could not be closed by its titlebar button at all. It now always
//    ends in an explicit Rust destroy — or, with background mode on, in a hide.
//  • the preference, re-mirrored down because `BackgroundState` is process-local
//    and starts false.
//  • the tray's copy, which is native and cannot read the i18n catalog.
//
// All three are scoped to the window that owns the app's persisted state. The
// preference and the tray copy are process-global levers, and a tile window or an
// activity screen re-asserting them would mean N toasts for one refusal. The
// guard is scoped for a different reason: registering a close listener is what
// makes Tauri's core prevent the close in the first place, so arming one inside a
// SATELLITE would turn `closeSatelliteWindow`'s direct `close()` into a round
// trip through that satellite's own JS — and a satellite whose page had not
// finished booting would then survive the teardown that is supposed to take it
// down with its summoner. Tile windows still arm it lazily from
// `openSatelliteWindow`, because a window that claims a satellite has to be able
// to close it; a satellite never gets that far (`canOpenSatelliteWindow` is false
// inside one).
// Every window follows the registry: a rename made in a settings Activity has to
// reach the shell painting the source chip. Outside the `ownsPersistedAppState`
// block on purpose — following is not restoring.
startConnectionsWatcher()

if (ownsPersistedAppState()) {
  void installWindowCloseGuard()
  initBackgroundMode()
  initTray()

  // The gateway registry (MJXHRM-446). Deliberately AFTER the restore above and
  // deliberately not awaited: `autoRestoreConnection()` has already dialled the
  // saved target, and this only re-points it when the launch mode disagrees.
  // Firing its own dial here is how desktop ends up with two sockets and a
  // flickering picker at launch. Satellites and activity screens skip it — they
  // follow the switch broadcast instead of replaying a restore.
  void initializeConnectionsRegistry()

  // `hermes:surface-grant:<surface>` is localStorage and outlives the PROCESS,
  // so an explicit Quit (or a crash) leaves one behind with nothing alive to
  // hear the native close event. The next run's HUD would lay itself out for a
  // layer surface it never got. Asks the window system what is actually up, so
  // an instance window booting beside a live HUD sweeps nothing.
  void sweepStaleSurfaceGrants()
}

// Pull KaTeX's faces in at idle. They are `font-display: block`, so the first
// equation of a session otherwise renders INVISIBLE until they land (see
// lib/katex-fonts).
warmKatexFonts()

// Publish deterministic `--safe-area-inset-*` CSS vars so mobile chrome sits
// correctly from the first frame instead of flashing at the 0 that env()
// reports before the webview resolves it (see lib/safe-area). No-op on web/
// desktop. Mark the platform so mobile-only CSS can key off `html.is-mobile`.
initSafeAreaInsets()
document.documentElement.classList.toggle('is-mobile', IS_MOBILE)

const container = document.getElementById('root')

if (!container) {
  throw new Error('root container missing')
}

createRoot(container).render(
  <RootErrorBoundary>
    <I18nProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <HapticsProvider>
            {/* ONE tooltip provider for the whole app. Every `Tip` used to carry
                its own, and with ~100 call sites those subtrees dominated
                unrelated interactions. Radix's provider holds only refs and
                stable callbacks, so hoisting is what it is for. */}
            <RootTooltipProvider>
              <HashRouter>
                <RouterNavBridge />
                <App />
              </HashRouter>
            </RootTooltipProvider>
          </HapticsProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  </RootErrorBoundary>
)
