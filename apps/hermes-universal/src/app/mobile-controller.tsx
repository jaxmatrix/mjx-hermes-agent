import { type ReactNode, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { ConnectScreen } from '@/app/connect-screen'
import { GatewayConnectingScreen } from '@/app/gateway/gateway-connecting-screen'
import { ModelPickerOverlay } from '@/app/model-picker-overlay'
import { ModelVisibilityOverlay } from '@/app/model-visibility-overlay'
import { FloatingPet } from '@/app/pet/floating-pet'
import { StarmapView } from '@/app/starmap'
import { NotificationStack } from '@/components/notifications'
import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { ResourcePressureBanner } from '@/components/resource-pressure-banner'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useStore } from '@/store/atom'
import { $connectionPhase, $hasConnected } from '@/store/connection'
import { requestGateway } from '@/store/gateway-client'
import { $restoring } from '@/store/gateway-restore'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { $pinnedSessionIds, pinSession, unpinSession } from '@/store/layout'
import { startLiveSessionSync } from '@/store/live-session-status'
import { startNewSession, startNewSessionTab } from '@/store/new-session'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $selectedStoredSessionId,
  $sessions,
  sessionMatchesStoredId,
  sessionPinId
} from '@/store/session'
import { archiveSessionLocal } from '@/store/session-lifecycle'
import { openAppRoute } from '@/store/windows'
import { bumpZoom, initZoom, setZoomPercent } from '@/store/zoom-universal'

import { CommandPalette } from './command-palette'
import { useKeybinds } from './hooks/use-keybinds'
import { COMMAND_CENTER_ROUTE, GATEWAY_SETTINGS_ROUTE, sessionRoute } from './routes'
import { SessionSwitcher } from './session-switcher'
import { useOverlayRouting } from './shell/hooks/use-overlay-routing'
import { MobileShell } from './shell/mobile-shell'
import { MobileSurfaceShell } from './shell/mobile-surface-shell'
import { SidebarProvider } from './shell/sidebar'

// The PHONE's main-window root (`app.tsx` sends the desktop main window to
// desktop's own root instead). Connected-guard + routing: until a gateway
// connection is ready we show the full-screen ConnectScreen (no nav). Once ready,
// desktop's onboarding overlay owns first-run / manual provider setup; otherwise
// the touch shell hosts the routed views. The toast stack (portaled to <body>)
// floats over all.
export function MobileController() {
  const phase = useStore($connectionPhase)
  const restoring = useStore($restoring)
  const hasConnected = useStore($hasConnected)
  const switching = useStore($gatewaySwitching)
  const activeProfile = useStore($activeGatewayProfile)

  // Publishes --visual-viewport-{height,top} / --keyboard-inset /
  // data-keyboard-open for the WHOLE mobile app, not just the shells.
  // `html.is-mobile #root` is sized from those vars (styles.css), and
  // ConnectScreen / GatewayConnectingScreen all render OUTSIDE MobileShell
  // below while holding focusable fields — so measuring only inside the shells
  // left those screens on the layout viewport, and a disconnect while typing
  // (which swaps the shell for the connecting screen) stripped the vars out
  // from under #root mid-keyboard. Inert off-mobile: desktop reports offsetTop
  // 0 and a visual viewport the size of the layout one. The hook refcounts ONE
  // module-level subscription, so the shells' own calls stay free.
  useKeyboardInset()

  // UI scale: apply the persisted zoom once, and wire Cmd/Ctrl +/-/0 shortcuts.
  // Zoom stays outside the rebindable registry — desktop keeps it out too.
  useEffect(() => {
    initZoom()

    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return
      }

      if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        bumpZoom(10)
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        bumpZoom(-10)
      } else if (event.key === '0') {
        event.preventDefault()
        setZoomPercent(100)
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Live-session rehydration + the coalesced session-list refresh
  // (store/live-session-status). Started HERE, not in app/contrib/controller:
  // that module is also imported by the tile and HUD satellite windows, and a
  // per-window poller would multiply the traffic this ticket exists to remove.
  // The store owns its own gateway gating, so it is armed once for the window's
  // whole life rather than per connection phase.
  useEffect(() => startLiveSessionSync(), [])

  // A soft gateway switch (store/gateway-switch.ts) drops the socket for a moment
  // while it re-dials. Treat that window as live so the shell — and the surface
  // driving the switch (Settings, the statusbar gateway popover) — stays mounted
  // instead of bouncing to the connecting screen. Only once we've been connected:
  // on a first run the connect screen owns the dial and must keep it.
  const live = phase === 'ready' || (switching && hasConnected)
  const connected = live

  // Which windowable surface (settings / command-center / agents / cron / …) the
  // route names, and the "return to where you were" path — desktop's
  // shell/hooks/use-overlay-routing.
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const {
    agentsOpen,
    closeOverlayToPreviousRoute,
    commandCenterOpen,
    cronOpen,
    profilesOpen,
    starmapOpen,
    settingsOpen,
    webhooksOpen
  } = useOverlayRouting()

  // The single global listener for every rebindable hotkey, plus the keybind
  // panel's capture mode (ported from desktop). It supersedes the ad-hoc ⌘B/⌘⇧F/
  // ⌘G/⌘N and ⌘K listeners this app used to carry. Mounted unconditionally so
  // the keys work on the connect / onboarding screens too.
  useKeybinds({
    archiveSelectedSession: () => {
      const sessionId = $selectedStoredSessionId.get()

      if (sessionId) {
        void archiveSessionLocal(sessionId)
      }
    },
    openNewSessionTab: () => startNewSessionTab(),
    startFreshSession: () => startNewSession(),
    toggleCommandCenter: () => (commandCenterOpen ? closeOverlayToPreviousRoute() : openAppRoute(COMMAND_CENTER_ROUTE)),
    toggleSelectedPin: () => {
      const sessionId = $selectedStoredSessionId.get()

      if (!sessionId) {
        return
      }

      const session = $sessions.get().find(s => sessionMatchesStoredId(s, sessionId))
      const pinId = session ? sessionPinId(session) : sessionId

      if ($pinnedSessionIds.get().includes(pinId)) {
        unpinSession(pinId)
      } else {
        pinSession(pinId)
      }
    }
  })

  // Only the Gateway settings page is usable while disconnected (it's the
  // reconnect / sign-in surface). Every other settings section needs live gateway
  // data, so keeping the overlay mounted there while disconnected would just render
  // empty sections — so a disconnect only holds the overlay open on Gateway.
  const settingsGatewayOpen = pathname === GATEWAY_SETTINGS_ROUTE

  // Whether any of the windowable surfaces (Settings / Command Center / Profiles /
  // Cron / Agents) is open — the trigger for the mobile in-app surface shell. Mirrors
  // the per-surface gates of the desktop overlays (Settings survives a disconnect on
  // the Gateway page; the others need a live connection).
  const mobileSurfaceOpen =
    (settingsOpen && (connected || settingsGatewayOpen)) ||
    (connected && (agentsOpen || commandCenterOpen || cronOpen || profilesOpen || webhooksOpen))

  let content: ReactNode

  if (!live) {
    // Not connected. Priority: a boot restore shows the connecting screen; if the
    // user is in Settings (e.g. they just signed out on the gateway page) keep a
    // neutral backdrop so the Settings overlay stays and shows the Sign in button
    // (desktop parity — sign-out doesn't bounce to the home/connect screen); an
    // in-session reconnect (dropped socket) shows the connecting screen; otherwise
    // it's a genuine first run → the connect screen.
    content = (
      <>
        <NotificationStack />
        {restoring ? (
          <GatewayConnectingScreen />
        ) : settingsGatewayOpen ? (
          <div className="h-full bg-background" />
        ) : hasConnected || phase === 'error' ? (
          // `phase === 'error'` keeps the terminal card mounted after the boot
          // ladder gives up: it clears `$restoring`, and on a cold launch
          // `hasConnected` is still false, so this used to fall through to the
          // first-run picker — throwing away WHICH gateway failed and why.
          <GatewayConnectingScreen />
        ) : (
          <ConnectScreen />
        )}
      </>
    )
  } else {
    content = (
      <>
        <NotificationStack />
        {/* Global command palette — ⌘K (the `nav.commandPalette` keybind),
            titlebar search, and the in-drawer button all open it; reaches every
            view not on the 4-item sidebar rail, plus sessions, settings fields,
            themes and plugin commands. */}
        <CommandPalette />
        {/* The ⌘F find bar is NOT here: it mounts once per WINDOW in app.tsx, so
            a detached tile / HUD / activity root gets it too (MJXHRM-387). */}
        {/* ⌃Tab session switcher HUD — keyboard-driven from useKeybinds. */}
        <SessionSwitcher />
        {/* The touch shell. A phone NEVER falls into desktop's docked tile tree,
            whatever width it measures. */}
        <MobileShell />
      </>
    )
  }

  // SidebarProvider wraps every branch so the shell's drawers have context on
  // all screens. No frameless-window chrome here: a phone keeps the native top
  // inset and per-screen headers.
  return (
    <SidebarProvider>
      <div className="relative flex h-full min-h-0 flex-col">
        {/* Resource-pressure bar (NS-656): disk exhaustion, memory pressure and
            suspected-OOM restarts, read off the `/api/status` snapshot the
            statusbar already polls (store/system-status.ts) — no second poller.
            A REAL in-flow row, so it can never cover the content it is warning about, and it renders
            nothing at all until the backend classifies a level. Mounted on the
            connected branch only: an unreachable gateway has no status to
            report, and the poll is gated on the socket being open anyway. */}
        {connected && <ResourcePressureBanner />}
        <div className="min-h-0 flex-1">{content}</div>
        {/* Mobile: Settings / Command Center / Profiles present as ONE full-screen
            in-app surface with the shared mobile chrome (top bar + two drawers),
            derived live from the route — parity with the Android native activity
            screen (MJX-203). Its OWN SidebarProvider isolates these drawers from the
            home MobileShell's drawers (both mount Sheets keyed to the same useSidebar
            booleans). Home/back navigates to the stashed route (NOT returnHome, whose
            iOS fallback would try to close the primary window). */}
        {mobileSurfaceOpen && (
          // `absolute`, not `fixed`: the parent above is `relative h-full` inside
          // a #root pinned to the VISIBLE viewport, so this fills the visible
          // rectangle. A `fixed inset-0` here is anchored to the LAYOUT viewport
          // and slides off the top of the screen the moment iOS reveals a caret —
          // the same bug the #root rule fixes for the home shell. Stacking is
          // unchanged: neither the parent nor #root creates a stacking context.
          <div className="absolute inset-0 z-50">
            <SidebarProvider>
              <MobileSurfaceShell
                onHome={closeOverlayToPreviousRoute}
                onNavigateRoute={path => navigate(path)}
                onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
              />
            </SidebarProvider>
          </div>
        )}
        {/* Star map overlay — the radial "what Hermes has learned" map. */}
        {connected && starmapOpen && <StarmapView onClose={closeOverlayToPreviousRoute} />}
        {/* First-run / manual provider setup — same overlay desktop wiring mounts. */}
        {connected && (
          <DesktopOnboardingOverlay
            enabled
            profile={activeProfile}
            requestGateway={requestGateway}
          />
        )}
        {/* Edit-models ("model visibility") dialog — opened from the composer's
            model menu ("Edit models"). Self-gates on $modelVisibilityOpen +
            gateway-open; "Add provider…" routes to Providers → Accounts. */}
        {connected && <ModelVisibilityOverlay onOpenProviders={() => openAppRoute('/settings/providers')} />}
        {/* Full model picker — the ⌘⇧M surface (composer.modelPicker) and the
            composer pill's fallback when there is no live dropdown. Self-gates
            on $modelPickerOpen + gateway-open, same as the dialog above. */}
        {connected && <ModelPickerOverlay onOpenProviders={() => openAppRoute('/settings/providers')} />}
        {/* Floating pet — a top-level draggable + roaming mascot that floats over
            ALL routes.

            On a phone it walks all four screen edges rather than only the floor,
            sits below the composer bars rather than over them, and lifts on
            contact (its box owns the gesture — see PET_TOUCH_ACTION). It is
            hidden while a MobileSurfaceShell surface is up: those are full-screen route
            surfaces with no card inset, so the overlay ledge the pet would
            patrol doesn't exist there. */}
        {connected && !mobileSurfaceOpen && (
          <FloatingPet
            overlayOpen={
              settingsOpen || agentsOpen || commandCenterOpen || cronOpen || profilesOpen || starmapOpen || webhooksOpen
            }
          />
        )}
      </div>
    </SidebarProvider>
  )
}
