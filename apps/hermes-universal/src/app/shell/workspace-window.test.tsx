import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { RootTooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/themes'

import {
  WorkspaceWindow,
  type WorkspacePrimaryTab,
  type WorkspaceSettingsSectionTab,
  type WorkspaceToolTab
} from './workspace-window'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: () => undefined }))

const SETTINGS_SECTIONS: readonly WorkspaceSettingsSectionTab[] = [
  { id: 'model', label: 'Model' },
  { id: 'chat', label: 'Chat' },
  { id: 'providers', label: 'Providers' },
  { id: 'keys', label: 'API keys' }
]

function WorkspaceHarness({
  initialPrimary = 'control' as WorkspacePrimaryTab,
  onOpenAgents = () => undefined,
  onSelectSettingsSection
}: {
  initialPrimary?: WorkspacePrimaryTab
  onOpenAgents?: () => void
  onSelectSettingsSection?: (id: string) => void
}) {
  const [primary, setPrimary] = useState<WorkspacePrimaryTab>(initialPrimary)
  const [tool, setTool] = useState<WorkspaceToolTab>('files')
  const [settingsSection, setSettingsSection] = useState('model')

  return (
    <WorkspaceWindow
      controlBody={<div>Control body</div>}
      onClose={() => undefined}
      onOpenAgents={onOpenAgents}
      onSelectPrimary={setPrimary}
      onSelectSettingsSection={id => {
        setSettingsSection(id)
        onSelectSettingsSection?.(id)
      }}
      onSelectTool={setTool}
      primaryTab={primary}
      profilesBody={<div>Profiles body</div>}
      settingsBody={<div>Settings body</div>}
      settingsSection={settingsSection}
      settingsSections={SETTINGS_SECTIONS}
      toolBodies={{
        editor: <div>Editor body</div>,
        files: <div>Files body</div>,
        review: <div>Review body</div>,
        terminal: <div>Terminal body</div>
      }}
      toolTab={tool}
    />
  )
}

function renderWorkspace(
  initialPrimary?: WorkspacePrimaryTab,
  openers?: {
    onOpenAgents?: () => void
    onSelectSettingsSection?: (id: string) => void
  }
) {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <RootTooltipProvider>
          <WorkspaceHarness initialPrimary={initialPrimary} {...openers} />
        </RootTooltipProvider>
      </ThemeProvider>
    </I18nProvider>
  )
}

describe('WorkspaceWindow', () => {
  it('puts Control, Workspace, Settings, Profiles, and Agents on the bottom rail', () => {
    const { container } = renderWorkspace()

    expect(screen.getByLabelText('Control')).toBeTruthy()
    expect(screen.getByLabelText('Workspace')).toBeTruthy()
    expect(screen.getByLabelText('Open settings')).toBeTruthy()
    expect(screen.getByLabelText('Profiles')).toBeTruthy()
    expect(screen.getByLabelText('Agents')).toBeTruthy()
    expect(screen.getByText('Control body')).toBeTruthy()

    // Control has no submenu — top strip stays in flow with close only.
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(container.querySelector('[data-slot="mobile-window-top"]')).toBeTruthy()
    expect(container.querySelector('[data-slot="mobile-window-close-float"]')).toBeNull()
    expect(screen.getByLabelText(/close/i)).toBeTruthy()

    const rail = container.querySelector('[data-slot="mobile-nav-rail"]')
    expect(rail?.querySelectorAll('button')).toHaveLength(5)
  })

  it('selects Settings and Profiles as primary panes; Agents still opens as overlay', async () => {
    const user = userEvent.setup()
    const onOpenAgents = vi.fn()

    const { container } = renderWorkspace('control', { onOpenAgents })

    await user.click(screen.getByLabelText('Open settings'))
    expect(screen.getByText('Settings body')).toBeTruthy()
    expect(container.querySelector('[data-slot="mobile-window-top"]')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Model' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeTruthy()

    await user.click(screen.getByLabelText('Profiles'))
    expect(screen.getByText('Profiles body')).toBeTruthy()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(container.querySelector('[data-slot="mobile-window-top"]')).toBeTruthy()

    await user.click(screen.getByLabelText('Agents'))
    expect(onOpenAgents).toHaveBeenCalledOnce()
  })

  it('calls onSelectSettingsSection from the Settings top tabs', async () => {
    const user = userEvent.setup()
    const onSelectSettingsSection = vi.fn()

    renderWorkspace('settings', { onSelectSettingsSection })

    await user.click(screen.getByRole('tab', { name: 'Chat' }))
    expect(onSelectSettingsSection).toHaveBeenCalledWith('chat')
    expect(screen.getByText('Settings body')).toBeTruthy()
  })

  it('shows tool tabs in the top bar when Workspace is selected from the rail', async () => {
    const user = userEvent.setup()
    const { container } = renderWorkspace('control')

    await user.click(screen.getByLabelText('Workspace'))

    const top = container.querySelector('[data-slot="mobile-window-top"]')
    expect(top).toBeTruthy()
    expect(top?.className).not.toMatch(/border-b/)
    expect(top?.querySelector('[role="tab"]')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Files' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Review' })).toBeTruthy()
    expect(screen.getByText('Files body')).toBeTruthy()

    await user.click(screen.getByLabelText('Control'))
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(container.querySelector('[data-slot="mobile-window-top"]')).toBeTruthy()
    expect(screen.getByText('Control body')).toBeTruthy()
  })
})
