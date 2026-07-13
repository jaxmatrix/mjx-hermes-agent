import { useEffect } from 'react'
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
import { useStore } from '@/store/atom'
import { $connectionPhase } from '@/store/connection'
import { $onboardingActive, checkConfigured } from '@/store/onboarding'
import { syncPetInfo } from '@/store/pet-gallery'

import { AppShell, SidebarProvider } from './shell/sidebar'

// Connected-guard + routing. Until a gateway connection is ready we show the
// full-screen ConnectScreen (no nav). Once ready, the first-run onboarding
// wizard shows if no provider is configured (K11); otherwise the sidebar shell
// hosts the routed views. The toast stack (portaled to <body>) floats over all.
export function MobileController() {
  const phase = useStore($connectionPhase)
  const onboarding = useStore($onboardingActive)

  // On reaching a live connection, check whether a provider is configured and
  // pull the active pet's sprite (K10.b) so the in-app pet can render in chat.
  useEffect(() => {
    if (phase === 'ready') {
      void checkConfigured()
      void syncPetInfo()
    }
  }, [phase])

  if (phase !== 'ready') {
    return (
      <>
        <NotificationStack />
        <ConnectScreen />
      </>
    )
  }

  if (onboarding) {
    return (
      <>
        <NotificationStack />
        <OnboardingScreen />
      </>
    )
  }

  return (
    <SidebarProvider>
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
          {/* Profile switching/projects gated (FIXME(E)); this is the CRUD/soul view. */}
          <Route element={<ProfilesScreen />} path="/profiles" />
          <Route element={<AgentsScreen />} path="/agents" />
          <Route element={<StarmapScreen />} path="/starmap" />
          <Route element={<FilesScreen />} path="/files" />
          <Route element={<ReviewScreen />} path="/review" />
          {/* Session ids (and anything else) resolve to chat, per routes.ts */}
          <Route element={<ChatScreen />} path="*" />
        </Routes>
      </AppShell>
    </SidebarProvider>
  )
}
