import { Route, Routes } from 'react-router-dom'

import { ChatScreen } from '@/app/chat/chat-screen'
import { ConnectScreen } from '@/app/connect-screen'
import { useStore } from '@/store/atom'
import { $connectionPhase } from '@/store/connection'

import { PlaceholderView } from './shell/placeholder-view'
import { AppShell, SidebarProvider } from './shell/sidebar'

// Connected-guard + routing. Until a gateway connection is ready we show the
// full-screen ConnectScreen (no nav); once ready, the sidebar shell hosts the
// routed views. Non-chat views are placeholders until their track ports them.
export function MobileController() {
  const phase = useStore($connectionPhase)

  if (phase !== 'ready') {
    return <ConnectScreen />
  }

  return (
    <SidebarProvider>
      <AppShell>
        <Routes>
          <Route element={<ChatScreen />} path="/" />
          {/* FIXME(J): port Settings */}
          <Route element={<PlaceholderView title="Settings" />} path="/settings" />
          {/* FIXME(K4): port Command Center */}
          <Route element={<PlaceholderView title="Command Center" />} path="/command-center" />
          {/* FIXME(K2): port Skills */}
          <Route element={<PlaceholderView title="Skills" />} path="/skills" />
          {/* FIXME(K6): port Messaging */}
          <Route element={<PlaceholderView title="Messaging" />} path="/messaging" />
          {/* FIXME(K7): port Artifacts */}
          <Route element={<PlaceholderView title="Artifacts" />} path="/artifacts" />
          {/* FIXME(K5): port Cron/Routines */}
          <Route element={<PlaceholderView title="Routines" />} path="/cron" />
          {/* FIXME(K1): port Profiles */}
          <Route element={<PlaceholderView title="Profiles" />} path="/profiles" />
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
