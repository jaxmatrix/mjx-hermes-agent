import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RootTooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/themes'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: () => undefined }))

const openReview = vi.fn()

vi.mock('@/store/review', () => ({
  openReview: (...args: unknown[]) => openReview(...args)
}))

vi.mock('@/store/windows', () => ({
  openAgentsScreen: vi.fn()
}))

vi.mock('@/store/preview-open', () => ({
  previewFile: vi.fn()
}))

vi.mock('@/app/shell/mobile-status-list', () => ({
  MobileStatusList: () => <div data-testid="control-body">Control</div>
}))

vi.mock('@/app/profiles', () => ({
  ProfilesView: () => <div data-testid="profiles-body">Profiles</div>
}))

vi.mock('@/app/settings/settings-section', () => ({
  SectionBody: () => <div data-testid="settings-body">Settings</div>
}))

vi.mock('@/app/settings/settings-view', () => ({
  SettingsFooter: () => null
}))

vi.mock('@/app/right-pane', () => ({
  RightSidebarPane: () => <div data-testid="files-body">Files</div>
}))

vi.mock('@/app/right-pane/preview/preview-rail', () => ({
  PreviewRail: () => <div data-testid="editor-body">Editor</div>
}))

vi.mock('@/app/right-pane/review', () => ({
  ReviewPane: () => <div data-testid="review-body">Review</div>
}))

vi.mock('@/app/right-pane/terminal/chrome', () => ({
  TerminalPaneChrome: () => <div data-testid="terminal-body">Terminal</div>
}))

import {
  resetWorkspaceWindowHostPrefsForTests,
  WorkspaceWindowHost
} from './workspace-window-host'

function renderHost() {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <RootTooltipProvider>
          <WorkspaceWindowHost onClose={() => undefined} />
        </RootTooltipProvider>
      </ThemeProvider>
    </I18nProvider>
  )
}

describe('WorkspaceWindowHost lazy mounts', () => {
  beforeEach(() => {
    openReview.mockClear()
    resetWorkspaceWindowHostPrefsForTests()
  })

  it('opens on Control without Settings, Profiles, Files, or openReview', () => {
    renderHost()

    expect(screen.getByTestId('control-body')).toBeTruthy()
    expect(screen.queryByTestId('settings-body')).toBeNull()
    expect(screen.queryByTestId('profiles-body')).toBeNull()
    expect(screen.queryByTestId('files-body')).toBeNull()
    expect(screen.queryByTestId('review-body')).toBeNull()
    expect(openReview).not.toHaveBeenCalled()
  })

  it('mounts Settings and Profiles only after first select', async () => {
    const user = userEvent.setup()

    renderHost()

    await user.click(screen.getByLabelText('Open settings'))
    expect(await screen.findByTestId('settings-body')).toBeTruthy()
    expect(screen.queryByTestId('profiles-body')).toBeNull()

    await user.click(screen.getByLabelText('Profiles'))
    expect(await screen.findByTestId('profiles-body')).toBeTruthy()
    // Settings stays mounted (visited) so tab state survives.
    expect(screen.getByTestId('settings-body')).toBeTruthy()
  })

  it('mounts Files when entering Workspace; openReview only on Review', async () => {
    const user = userEvent.setup()

    renderHost()

    await user.click(screen.getByLabelText('Workspace'))
    expect(await screen.findByTestId('files-body')).toBeTruthy()
    expect(openReview).not.toHaveBeenCalled()
    expect(screen.queryByTestId('review-body')).toBeNull()

    await user.click(screen.getByRole('tab', { name: 'Review' }))
    expect(await screen.findByTestId('review-body')).toBeTruthy()
    expect(openReview).toHaveBeenCalledOnce()
  })
})
