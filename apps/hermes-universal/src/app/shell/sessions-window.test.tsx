import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { RootTooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/themes'

import { SessionsWindow, type SessionsWindowTab } from './sessions-window'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: () => undefined }))

const NAV_ITEMS = [{ icon: 'robot', id: 'new', label: 'New', onSelect: () => undefined }]

const PROFILES = [
  { color: null, id: 'default', isDefault: true, name: 'Default' },
  { color: '#5b8def', id: 'work', isDefault: false, name: 'Work' }
]

function SessionsHarness({
  initialTab = 'sessions',
  onClose = vi.fn()
}: {
  initialTab?: SessionsWindowTab
  onClose?: () => void
}) {
  const [tab, setTab] = useState<SessionsWindowTab>(initialTab)

  return (
    <SessionsWindow
      activeTab={tab}
      botsBody={<div>Bots body</div>}
      navItems={NAV_ITEMS}
      onClose={onClose}
      onSelectProfile={() => undefined}
      onSelectTab={setTab}
      profiles={PROFILES}
      selectedProfileId="default"
      sessionsBody={<div>Sessions body</div>}
    />
  )
}

function renderSessions(props?: { initialTab?: SessionsWindowTab; onClose?: () => void }) {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <RootTooltipProvider>
          <SessionsHarness {...props} />
        </RootTooltipProvider>
      </ThemeProvider>
    </I18nProvider>
  )
}

describe('SessionsWindow', () => {
  it('shows Sessions and Bots tabs and closes via the ✕', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderSessions({ onClose })

    expect(screen.getByText('Sessions')).toBeTruthy()
    expect(screen.getByText('Bots')).toBeTruthy()
    expect(screen.getByText('Sessions body')).toBeTruthy()
    expect(screen.getByText('Default')).toBeTruthy()
    expect(screen.getByLabelText('New')).toBeTruthy()

    await user.click(screen.getByLabelText(/close/i))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the SIDEBAR_NAV rail on Sessions and hides it on Bots', async () => {
    const user = userEvent.setup()
    renderSessions()

    expect(screen.getByLabelText('New')).toBeTruthy()

    await user.click(screen.getByRole('tab', { name: 'Bots' }))
    expect(screen.getByText('Bots body')).toBeTruthy()
    expect(screen.queryByLabelText('New')).toBeNull()

    await user.click(screen.getByRole('tab', { name: 'Sessions' }))
    expect(screen.getByText('Sessions body')).toBeTruthy()
    expect(screen.getByLabelText('New')).toBeTruthy()
  })

  it('keeps chrome within a fixed-height parent when the body is tall', () => {
    const tall = (
      <div>
        {Array.from({ length: 80 }, (_, i) => (
          <div key={i}>row {i}</div>
        ))}
      </div>
    )

    const { container } = render(
      <I18nProvider>
        <ThemeProvider>
          <RootTooltipProvider>
            <div data-testid="frame" style={{ height: 400, width: 390 }}>
              <SessionsWindow
                activeTab="sessions"
                botsBody={<div>Bots</div>}
                navItems={NAV_ITEMS}
                onClose={() => undefined}
                onSelectProfile={() => undefined}
                onSelectTab={() => undefined}
                profiles={PROFILES}
                selectedProfileId="default"
                sessionsBody={tall}
              />
            </div>
          </RootTooltipProvider>
        </ThemeProvider>
      </I18nProvider>
    )

    const frame = screen.getByTestId('frame')
    const chrome = container.querySelector('[data-slot="sessions-window"]')
    const rail = container.querySelector('[data-slot="mobile-nav-rail"]')

    expect(chrome).toBeTruthy()
    expect(rail).toBeTruthy()
    expect(chrome!.getBoundingClientRect().height).toBeLessThanOrEqual(frame.getBoundingClientRect().height + 0.5)
    expect(screen.getByLabelText('New')).toBeTruthy()
  })
})
