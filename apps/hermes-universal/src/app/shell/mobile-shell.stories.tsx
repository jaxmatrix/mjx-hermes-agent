import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'

import { MobileChromeBar } from '@/app/shell/mobile-chrome-bar'
import type { MobileConnectionChromeStatus } from '@/app/shell/mobile-connection-chrome'
import type { MobileNavRailItem } from '@/app/shell/mobile-nav-rail'
import { mobileShellDecorators } from '@/app/shell/mobile-shell.stories-shared'
import { SessionsWindow, type SessionsWindowProfile, type SessionsWindowTab } from '@/app/shell/sessions-window'
import { TitlebarButton } from '@/app/shell/titlebar-button'
import {
  WorkspaceWindow,
  type WorkspacePrimaryTab,
  type WorkspaceToolTab
} from '@/app/shell/workspace-window'
import { Codicon } from '@/components/ui/codicon'

/**
 * Interaction prototype: chat surface + BubbleRow placeholder + left / Workspace
 * overlays. Mobile Storybook only — not the live MobileShell wiring.
 *
 * SIDEBAR_NAV rail lives on the Sessions overlay (Sessions tab), not on chat.
 * Top bar uses MobileChromeBar so reconnect chrome (orange / green) is visible.
 */

const PROFILES: SessionsWindowProfile[] = [
  { color: null, id: 'default', isDefault: true, name: 'Default' },
  { color: '#5b8def', id: 'work', isDefault: false, name: 'Work' }
]

function ShellComposition({
  connectionStatus = 'idle'
}: {
  connectionStatus?: MobileConnectionChromeStatus
}) {
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [leftTab, setLeftTab] = useState<SessionsWindowTab>('sessions')
  const [profileId, setProfileId] = useState('default')
  const [primary, setPrimary] = useState<WorkspacePrimaryTab>('control')
  const [tool, setTool] = useState<WorkspaceToolTab>('files')
  const [settingsSection, setSettingsSection] = useState('model')

  const navItems = useMemo<MobileNavRailItem[]>(
    () =>
      [
        { icon: 'robot', id: 'new', label: 'New' },
        { icon: 'symbol-misc', id: 'caps', label: 'Caps' },
        { icon: 'comment', id: 'msg', label: 'Msg' },
        { icon: 'files', id: 'arts', label: 'Arts' },
        { icon: 'search', id: 'search', label: 'Search' }
      ].map(item => ({ ...item, onSelect: () => undefined })),
    []
  )

  return (
    <div className="relative flex h-full flex-col bg-background" data-slot="mobile-shell-story">
      <MobileChromeBar
        center={<span className="ps-2 text-sm font-medium">Chat</span>}
        connectionStatus={connectionStatus}
        topBorder={false}
        left={
          <TitlebarButton density="mobile" label="Sessions" onClick={() => setLeftOpen(true)}>
            <Codicon name="history" size="1.4rem" />
          </TitlebarButton>
        }
        right={
          <TitlebarButton density="mobile" label="Workspace" onClick={() => setRightOpen(true)}>
            <Codicon name="layout-sidebar-right" size="1.4rem" />
          </TitlebarButton>
        }
      />

      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 text-sm text-muted-foreground">
        <p>Assistant reply placeholder.</p>
        <p className="mt-3">Open Sessions to see the New / Caps / … bottom rail.</p>
        {connectionStatus !== 'idle' ? (
          <p className="mt-3">
            Connection chrome: <code>{connectionStatus}</code>
          </p>
        ) : null}
      </main>

      {/* BubbleRow stand-in — real BubbleRow needs chat bubble store wiring. */}
      <div
        className="flex shrink-0 items-center justify-center gap-2 border-t border-(--ui-stroke-tertiary) px-2 py-2"
        data-slot="bubble-row-stub"
      >
        {['Brief', 'Sync fix', '+'].map(label => (
          <button
            className="rounded-full border border-border/70 px-3 py-1 text-xs"
            key={label}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="shrink-0 border-t border-(--ui-stroke-tertiary) px-3 py-3">
        <div className="rounded-xl border border-border/60 bg-(--ui-chat-surface-background) px-3 py-2 text-sm text-muted-foreground">
          Message Hermes…
        </div>
      </div>

      {leftOpen && (
        <div className="absolute inset-0 z-50">
          <SessionsWindow
            activeTab={leftTab}
            botsBody={<div className="grid h-full place-items-center text-sm">Bots</div>}
            navItems={navItems}
            onClose={() => setLeftOpen(false)}
            onSelectProfile={setProfileId}
            onSelectTab={setLeftTab}
            profiles={PROFILES}
            selectedProfileId={profileId}
            sessionsBody={<div className="grid h-full place-items-center text-sm">Sessions</div>}
          />
        </div>
      )}

      {rightOpen && (
        <div className="absolute inset-0 z-50">
          <WorkspaceWindow
            controlBody={<div className="grid h-full place-items-center text-sm">Control</div>}
            onClose={() => setRightOpen(false)}
            onOpenAgents={() => setRightOpen(false)}
            onSelectPrimary={setPrimary}
            onSelectSettingsSection={setSettingsSection}
            onSelectTool={setTool}
            primaryTab={primary}
            profilesBody={<div className="grid h-full place-items-center text-sm">Profiles</div>}
            settingsBody={<div className="grid h-full place-items-center text-sm">Settings</div>}
            settingsSection={settingsSection}
            settingsSections={[
              { id: 'model', label: 'Model' },
              { id: 'chat', label: 'Chat' }
            ]}
            toolBodies={{
              editor: <div className="grid h-full place-items-center text-sm">Editor</div>,
              files: <div className="grid h-full place-items-center text-sm">Files</div>,
              review: <div className="grid h-full place-items-center text-sm">Review</div>,
              terminal: <div className="grid h-full place-items-center text-sm">Terminal</div>
            }}
            toolTab={tool}
          />
        </div>
      )}
    </div>
  )
}

const meta = {
  title: 'Mobile/Shell',
  component: ShellComposition,
  decorators: mobileShellDecorators,
  parameters: { layout: 'fullscreen' },
  argTypes: {
    connectionStatus: {
      control: 'select',
      options: ['idle', 'reconnecting', 'reconnected']
    }
  },
  args: {
    connectionStatus: 'idle'
  }
} satisfies Meta<typeof ShellComposition>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Reconnecting: Story = {
  args: { connectionStatus: 'reconnecting' }
}

export const Reconnected: Story = {
  args: { connectionStatus: 'reconnected' }
}
