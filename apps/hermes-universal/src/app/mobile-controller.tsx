import { type ReactNode, useEffect, useRef } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'

import { AgentsScreen } from '@/app/agents/agents-screen'
import { ArtifactsScreen } from '@/app/artifacts/artifacts-screen'
import { ChatScreen } from '@/app/chat/chat-screen'
import { CommandCenterScreen } from '@/app/command-center/command-center-screen'
import { ConnectScreen } from '@/app/connect-screen'
import { CronScreen } from '@/app/cron/cron-screen'
import { FilesScreen } from '@/app/files/files-screen'
import { MessagingScreen } from '@/app/messaging/messaging-screen'
import { OnboardingScreen } from '@/app/onboarding/onboarding-screen'
import { ProfilesScreen } from '@/app/profiles/profiles-screen'
import { ReviewScreen } from '@/app/review/review-screen'
import { SkillsScreen } from '@/app/skills/skills-screen'
import { StarmapScreen } from '@/app/starmap/starmap-screen'
import { FloatingPet } from '@/app/pet/floating-pet'
import { ProviderConnectOverlay } from '@/app/settings/provider-connect-overlay'
import { SettingsView } from '@/app/settings/settings-view'
import { NotificationStack } from '@/components/notifications'
import { IS_DESKTOP } from '@/lib/platform'
import { useThemedScrollbars } from '@/lib/scrollbars'
import { useStore } from '@/store/atom'
import { $connectionPhase } from '@/store/connection'
import { $onboardingActive, checkConfigured } from '@/store/onboarding'
import { syncPetInfo } from '@/store/pet-gallery'
import { bumpZoom, initZoom, setZoomPercent } from '@/store/zoom'

import { CommandMenu } from './shell/command-menu'
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

  // Settings is a top-level overlay portal (desktop parity) rather than a routed
  // pane: the underlying route (chat) stays as the backdrop and the portal floats
  // over it. Open state is derived from the URL.
  const { pathname } = useLocation()
  const settingsOpen = pathname === '/settings' || pathname.startsWith('/settings/')
  // Remember the route the user was on before settings opened, so the portal's
  // close button returns there instead of stepping back one settings section.
  const returnPathRef = useRef('/')
  useEffect(() => {
    if (!settingsOpen) {
      returnPathRef.current = pathname
    }
  }, [settingsOpen, pathname])

  let content: ReactNode
  if (phase !== 'ready') {
    content = (
      <>
        <NotificationStack />
        <ConnectScreen />
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
            <Route element={<CommandCenterScreen />} path="/command-center" />
            {/* Skills + Toolsets; MCP/Hub tabs land in Kc7/Kc8. */}
            <Route element={<SkillsScreen />} path="/skills" />
            <Route element={<MessagingScreen />} path="/messaging" />
            <Route element={<ArtifactsScreen />} path="/artifacts" />
            <Route element={<CronScreen />} path="/cron" />
            {/* CRUD/soul view; active-profile switching lives in Settings → Gateway (E7). */}
            <Route element={<ProfilesScreen />} path="/profiles" />
            <Route element={<AgentsScreen />} path="/agents" />
            <Route element={<StarmapScreen />} path="/starmap" />
            <Route element={<FilesScreen />} path="/files" />
            <Route element={<ReviewScreen />} path="/review" />
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
            (z-40) and chat backdrop. Connected-only (it reads live config). */}
        {connected && settingsOpen && <SettingsView returnPath={returnPathRef.current} />}
        {/* Provider-connect overlay — a focused per-provider sign-in card that
            floats OVER the settings page (z-70) without unmounting it. Opened from
            Providers → Accounts; gated on $connectProvider, not $onboardingActive. */}
        {connected && <ProviderConnectOverlay />}
        {/* Floating pet — a top-level draggable + roaming mascot (fixed z-60) that
            floats over ALL routes. It patrols the Settings overlay's edge when open. */}
        {connected && <FloatingPet overlayOpen={settingsOpen} />}
      </div>
    </SidebarProvider>
  )
}
