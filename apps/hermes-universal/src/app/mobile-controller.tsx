import { type ReactNode, useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'

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
import { SettingsIndex } from '@/app/settings/settings-index'
import { SettingsSection } from '@/app/settings/settings-section'
import { NotificationStack } from '@/components/notifications'
import { IS_DESKTOP } from '@/lib/platform'
import { useThemedScrollbars } from '@/lib/scrollbars'
import { useStore } from '@/store/atom'
import { $connectionPhase } from '@/store/connection'
import { $onboardingActive, checkConfigured } from '@/store/onboarding'
import { syncPetInfo } from '@/store/pet-gallery'

import { AppShell, SidebarProvider } from './shell/sidebar'
import { Titlebar } from './shell/titlebar'

// Connected-guard + routing. Until a gateway connection is ready we show the
// full-screen ConnectScreen (no nav). Once ready, the first-run onboarding
// wizard shows if no provider is configured (K11); otherwise the sidebar shell
// hosts the routed views. The toast stack (portaled to <body>) floats over all.
export function MobileController() {
  const phase = useStore($connectionPhase)
  const onboarding = useStore($onboardingActive)

  // Draw custom (WebKitGTK-safe) scrollbars on desktop; no-op on mobile/web.
  useThemedScrollbars()

  // On reaching a live connection, check whether a provider is configured and
  // pull the active pet's sprite (K10.b) so the in-app pet can render in chat.
  useEffect(() => {
    if (phase === 'ready') {
      void checkConfigured()
      void syncPetInfo()
    }
  }, [phase])

  const connected = phase === 'ready' && !onboarding

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
        <AppShell>
          <Routes>
            <Route element={<ChatScreen />} path="/" />
            <Route element={<SettingsIndex />} path="/settings" />
            <Route element={<SettingsSection />} path="/settings/:section" />
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
      <div className="flex h-full min-h-0 flex-col">
        {IS_DESKTOP && <Titlebar connected={connected} />}
        <div className="min-h-0 flex-1">{content}</div>
      </div>
    </SidebarProvider>
  )
}
