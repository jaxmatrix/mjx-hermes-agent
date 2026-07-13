import { Route, Routes } from 'react-router-dom'

import { ArtifactsScreen } from '@/app/artifacts/artifacts-screen'
import { ChatScreen } from '@/app/chat/chat-screen'
import { ConnectScreen } from '@/app/connect-screen'
import { CronScreen } from '@/app/cron/cron-screen'
import { MessagingScreen } from '@/app/messaging/messaging-screen'
import { ProfilesScreen } from '@/app/profiles/profiles-screen'
import { SkillsScreen } from '@/app/skills/skills-screen'
import { SettingsIndex } from '@/app/settings/settings-index'
import { SettingsSection } from '@/app/settings/settings-section'
import { NotificationStack } from '@/components/notifications'
import { useStore } from '@/store/atom'
import { $connectionPhase } from '@/store/connection'

import { PlaceholderView } from './shell/placeholder-view'
import { AppShell, SidebarProvider } from './shell/sidebar'

// Connected-guard + routing. Until a gateway connection is ready we show the
// full-screen ConnectScreen (no nav); once ready, the sidebar shell hosts the
// routed views. Non-chat views are placeholders until their track ports them.
// The toast stack (portaled to <body>) floats over both phases.
export function MobileController() {
  const phase = useStore($connectionPhase)

  if (phase !== 'ready') {
    return (
      <>
        <NotificationStack />
        <ConnectScreen />
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
          {/* FIXME(K4): port Command Center */}
          <Route element={<PlaceholderView title="Command Center" />} path="/command-center" />
          {/* Skills + Toolsets; MCP/Hub tabs land in Kc7/Kc8. */}
          <Route element={<SkillsScreen />} path="/skills" />
          <Route element={<MessagingScreen />} path="/messaging" />
          <Route element={<ArtifactsScreen />} path="/artifacts" />
          <Route element={<CronScreen />} path="/cron" />
          {/* Profile switching/projects gated (FIXME(E)); this is the CRUD/soul view. */}
          <Route element={<ProfilesScreen />} path="/profiles" />
          {/* FIXME(K3): port Agents */}
          <Route element={<PlaceholderView title="Agents" />} path="/agents" />
          {/* FIXME(K8): port Starmap */}
          <Route element={<PlaceholderView title="Starmap" />} path="/starmap" />
          {/* Session ids (and anything else) resolve to chat, per routes.ts */}
          <Route element={<ChatScreen />} path="*" />
        </Routes>
      </AppShell>
    </SidebarProvider>
  )
}
