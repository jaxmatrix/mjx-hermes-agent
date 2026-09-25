import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'

import { mobileShellDecorators } from '@/app/shell/mobile-shell.stories-shared'
import {
  WorkspaceWindow,
  type WorkspacePrimaryTab,
  type WorkspaceSettingsSectionTab,
  type WorkspaceToolTab
} from '@/app/shell/workspace-window'

const SETTINGS_SECTIONS: readonly WorkspaceSettingsSectionTab[] = [
  { id: 'model', label: 'Model' },
  { id: 'chat', label: 'Chat' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'keys', label: 'API keys' }
]

function PaneStub({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center text-sm text-muted-foreground" data-slot="pane-stub">
      {label}
    </div>
  )
}

function WorkspaceWindowHarness({ startPrimary = 'control' as WorkspacePrimaryTab }) {
  const [primary, setPrimary] = useState<WorkspacePrimaryTab>(startPrimary)
  const [tool, setTool] = useState<WorkspaceToolTab>('files')
  const [settingsSection, setSettingsSection] = useState('model')
  const [closed, setClosed] = useState(false)

  if (closed) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        Closed — refresh story to reopen
      </div>
    )
  }

  return (
    <WorkspaceWindow
      controlBody={
        <div className="flex flex-col gap-2 overflow-y-auto px-3 py-3 text-sm">
          <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Control</div>
          <div className="rounded-md border border-border/60 px-3 py-2">Gateway · Connected</div>
          <div className="rounded-md border border-border/60 px-3 py-2">Model · claude-opus</div>
          <div className="rounded-md border border-border/60 px-3 py-2">Credits · OK</div>
        </div>
      }
      onClose={() => setClosed(true)}
      onOpenAgents={() => setClosed(true)}
      onSelectPrimary={setPrimary}
      onSelectSettingsSection={setSettingsSection}
      onSelectTool={setTool}
      primaryTab={primary}
      profilesBody={<PaneStub label="Profiles" />}
      settingsBody={<PaneStub label={`Settings · ${settingsSection}`} />}
      settingsSection={settingsSection}
      settingsSections={SETTINGS_SECTIONS}
      toolBodies={{
        editor: <PaneStub label="Editor" />,
        files: <PaneStub label="Files" />,
        review: <PaneStub label="Review" />,
        terminal: <PaneStub label="Terminal" />
      }}
      toolTab={tool}
    />
  )
}

const meta = {
  title: 'Mobile/Workspace window',
  component: WorkspaceWindowHarness,
  decorators: mobileShellDecorators,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof WorkspaceWindowHarness>

export default meta
type Story = StoryObj<typeof meta>

export const Control: Story = {
  args: { startPrimary: 'control' }
}

export const WorkspaceTools: Story = {
  args: { startPrimary: 'workspace' }
}

export const Settings: Story = {
  args: { startPrimary: 'settings' }
}

export const Profiles: Story = {
  args: { startPrimary: 'profiles' }
}
