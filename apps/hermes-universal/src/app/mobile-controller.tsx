import { type ReactNode, useEffect } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'

import { AgentsView } from '@/app/agents'
import { ArtifactsView } from '@/app/artifacts'
import { ChatScreen } from '@/app/chat/chat-screen'
import { CommandCenterView } from '@/app/command-center'
import { ConnectScreen } from '@/app/connect-screen'
import { GatewayConnectingScreen } from '@/app/gateway/gateway-connecting-screen'
import { CronView } from '@/app/cron'
import { MessagingView } from '@/app/messaging'
import { OnboardingScreen } from '@/app/onboarding/onboarding-screen'
import { ProfilesView } from '@/app/profiles'
import { SkillsView } from '@/app/skills'
import { StarmapView } from '@/app/starmap'
import { FloatingPet } from '@/app/pet/floating-pet'
import { ProviderConnectOverlay } from '@/app/settings/provider-connect-overlay'
import { SettingsView } from '@/app/settings/settings-view'
import { NotificationStack } from '@/components/notifications'
import { IS_DESKTOP } from '@/lib/platform'
import { useThemedScrollbars } from '@/lib/scrollbars'
import { useStore } from '@/store/atom'
import { $connectionPhase, $hasConnected } from '@/store/connection'
import { $restoring } from '@/store/gateway-restore'
import { $onboardingActive, checkConfigured } from '@/store/onboarding'
import { syncPetInfo } from '@/store/pet-gallery'
import { deleteSessionLocal } from '@/store/session'
import { bumpZoom, initZoom, setZoomPercent } from '@/store/zoom'

import { sessionRoute } from './routes'
import { CommandMenu } from './shell/command-menu'
import { useOverlayRouting } from './shell/hooks/use-overlay-routing'
import { AppShell, SidebarProvider } from './shell/sidebar'
import { Statusbar } from './shell/statusbar'
import { Titlebar } from './shell/titlebar'
import { useSidebarKeybinds } from './shell/use-sidebar-keybinds'

// Connected-guard + routing. Until a gateway connection is ready we show the
// full-screen ConnectScreen (no nav). Once ready, the first-run onboarding
// wizard shows if no provider is configured (K11); otherwise the sidebar shell
// hosts the routed views. The toast stack (portaled to <body>) floats over all.
export function MobileController() {
  const phase = useStore($connectionPhase)
  const onboarding = useStore($onboardingActive)
  const restoring = useStore($restoring)
  const hasConnected = useStore($hasConnected)

  // Draw custom (WebKitGTK-safe) scrollbars on desktop; no-op on mobile/web.
  useThemedScrollbars()

  // Sidebar shortcuts (mod+b / mod+shift+f / mod+n).
  useSidebarKeybinds()

  // UI scale: apply the persisted zoom once, and wire Cmd/Ctrl +/-/0 shortcuts.
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

  // On reaching a live connection, check whether a provider is configured and
  // pull the active pet's sprite (K10.b) so the in-app pet can render in chat.
  useEffect(() => {
    if (phase === 'ready') {
      void checkConfigured()
      void syncPetInfo()
    }
  }, [phase])

  const connected = phase === 'ready' && !onboarding

  // Overlay views (settings / command-center / agents / cron / …) are top-level
  // portals rather than routed panes — desktop parity: the underlying route (chat)
  // stays as the backdrop and the portal floats over it. Open state and the
  // "return to where you were" path both come from the shared hook ported from
  // desktop's shell/hooks/use-overlay-routing.
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const {
    agentsOpen,
    closeOverlayToPreviousRoute,
    commandCenterOpen,
    cronOpen,
    profilesOpen,
    returnPathRef,
    starmapOpen,
    settingsOpen
  } = useOverlayRouting()
  // Only the Gateway settings page is usable while disconnected (it's the
  // reconnect / sign-in surface). Every other settings section needs live gateway
  // data, so keeping the overlay mounted there while disconnected would just render
  // empty sections — so a disconnect only holds the overlay open on Gateway.
  const settingsGatewayOpen = pathname === '/settings/gateway'

  let content: ReactNode
  if (phase !== 'ready') {
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
        ) : hasConnected ? (
          <GatewayConnectingScreen />
        ) : (
          <ConnectScreen />
        )}
      </>
    )
  } else if (onboarding) {
    content = (
      <>
        <NotificationStack />
        <OnboardingScreen />
      </>
    )
  } else {
    content = (
      <>
        <NotificationStack />
        {/* Global command menu — ⌘K, titlebar search, and the in-drawer button
            all open it; reaches every view not on the 4-item sidebar rail. */}
        <CommandMenu />
        <AppShell>
          <Routes>
            <Route element={<ChatScreen />} path="/" />
            {/* /settings* falls through to the chat backdrop; the settings portal
                itself renders as a top-level overlay below (fixed z-50). */}
            {/* /command-center falls through to the chat backdrop; the Command
                Center overlay renders as a top-level portal below (fixed z-50). */}
            {/* Capabilities: Skills · Toolsets · MCP · Hub (ported from desktop). */}
            <Route element={<SkillsView />} path="/skills" />
            <Route element={<MessagingView />} path="/messaging" />
            <Route element={<ArtifactsView />} path="/artifacts" />
            {/* /cron falls through to the chat backdrop; the Cron overlay
                renders as a top-level portal below (fixed z-50). */}
            {/* /profiles falls through to the chat backdrop; the Profiles overlay
                renders as a top-level portal below (fixed z-50). */}
            {/* /agents falls through to the chat backdrop; the Agents ("Spawn
                tree") overlay renders as a top-level portal below (fixed z-50). */}
            {/* /starmap falls through to the chat backdrop; the Star map overlay
                renders as a top-level portal below (fixed z-50). */}
            {/* No /files or /review routes — desktop parity: Files is the
                right-pane file tree and Review is the right-pane git diff, both
                mounted in AppShell rather than routed. */}
            {/* Session ids (and anything else) resolve to chat, per routes.ts */}
            <Route element={<ChatScreen />} path="*" />
          </Routes>
        </AppShell>
      </>
    )
  }

  // SidebarProvider wraps every branch so the desktop Titlebar's sidebar button
  // has context on all screens. The frameless-window chrome (Titlebar) mounts
  // above the routed content on desktop Tauri only; mobile/web keep the native
  // top inset and per-screen headers.
  return (
    <SidebarProvider>
      <div className="relative flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">{content}</div>
        {/* Bottom statusbar (ported from desktop): a real shrink-0 row below the
            content, so it reserves space and stays visible under the overlay
            titlebar. Connected-only — it reads live gateway/session state. */}
        {connected && <Statusbar />}
        {/* Frameless chrome floats as a transparent overlay above the content so
            the sidebar/main panes extend to y=0 and their division shows through
            the titlebar band (Requirement #1). Desktop Tauri only. */}
        {IS_DESKTOP && <Titlebar connected={connected} />}
        {/* Settings portal — a full-window overlay (fixed z-50) over the titlebar
            (z-40) and chat backdrop. Stays mounted while disconnected too (a
            settings-initiated "Save & reconnect", or a sign-out) so reconfiguring or
            re-authenticating the gateway never bounces the user out to the connect
            picker — desktop parity. Blocked only during the first-run onboarding
            wizard (phase ready but not connected). */}
        {settingsOpen && (connected || settingsGatewayOpen) && <SettingsView returnPath={returnPathRef.current} />}
        {/* Agents ("Spawn tree") overlay — desktop's live subagent surface,
            floated over the chat backdrop and opened from the statusbar Agents
            item. Its Panel supplies the fixed-inset card + close-X / Esc. */}
        {connected && agentsOpen && <AgentsView onClose={closeOverlayToPreviousRoute} />}
        {/* Command Center overlay — desktop's Sessions / System / Usage /
            Maintenance ops surface, opened from the statusbar (icon + version
            chips) and the sidebar rail. */}
        {connected && commandCenterOpen && (
          <CommandCenterView
            onClose={closeOverlayToPreviousRoute}
            onDeleteSession={deleteSessionLocal}
            onNavigateRoute={path => navigate(path)}
            onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
          />
        )}
        {/* Cron ("Routines") overlay — desktop's scheduled-jobs master/detail:
            schedule, run history, pause/resume/trigger. Opened from the sidebar
            rail and from "Manage" on a sidebar cron row. */}
        {connected && cronOpen && (
          <CronView
            onClose={closeOverlayToPreviousRoute}
            onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
          />
        )}
        {/* Profiles overlay — desktop's profile CRUD + soul editor master/detail. */}
        {connected && profilesOpen && <ProfilesView onClose={closeOverlayToPreviousRoute} />}
        {/* Star map overlay — the radial "what Hermes has learned" map. */}
        {connected && starmapOpen && <StarmapView onClose={closeOverlayToPreviousRoute} />}
        {/* Provider-connect overlay — a focused per-provider sign-in card that
            floats OVER the settings page (z-70) without unmounting it. Opened from
            Providers → Accounts; gated on $connectProvider, not $onboardingActive. */}
        {connected && <ProviderConnectOverlay />}
        {/* Floating pet — a top-level draggable + roaming mascot (fixed z-60) that
            floats over ALL routes. It patrols the Settings overlay's edge when open. */}
        {connected && <FloatingPet overlayOpen={settingsOpen || agentsOpen || commandCenterOpen || cronOpen || profilesOpen || starmapOpen} />}
      </div>
    </SidebarProvider>
  )
}
