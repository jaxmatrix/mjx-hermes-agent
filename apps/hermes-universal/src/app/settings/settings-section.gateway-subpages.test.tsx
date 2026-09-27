import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/themes'

vi.mock('./gateway-settings', () => ({
  GatewaySettings: ({ subpage }: { subpage?: string }) => (
    <div data-testid="gateway-settings" data-subpage={subpage ?? ''}>
      GatewaySettings
    </div>
  )
}))

vi.mock('./appearance-settings', () => ({
  AppearanceSettings: ({ subpage }: { subpage?: string }) => (
    <div data-testid="appearance-settings" data-subpage={subpage ?? ''}>
      AppearanceSettings
    </div>
  )
}))

vi.mock('./config-settings', () => ({
  ConfigSettings: ({ activeSectionId, subpage }: { activeSectionId: string; subpage?: string }) => (
    <div data-section={activeSectionId} data-subpage={subpage ?? ''} data-testid="config-settings">
      ConfigSettings
    </div>
  )
}))

vi.mock('./notifications-settings', () => ({
  NotificationsSettings: ({ subpage }: { subpage?: string }) => (
    <div data-testid="notifications-settings" data-subpage={subpage ?? ''}>
      Notifications
    </div>
  )
}))

vi.mock('./keybind-settings', () => ({
  KeybindSettings: ({ subpage }: { subpage?: string }) => (
    <div data-testid="keybind-settings" data-subpage={subpage ?? ''}>
      Keybinds
    </div>
  )
}))

vi.mock('./sessions-settings', () => ({
  SessionsSettings: ({ subpage }: { subpage?: string }) => (
    <div data-testid="sessions-settings" data-subpage={subpage ?? ''}>
      Sessions
    </div>
  )
}))

vi.mock('./about-settings', () => ({
  AboutSettings: ({ subpage }: { subpage?: string }) => (
    <div data-testid="about-settings" data-subpage={subpage ?? ''}>
      About
    </div>
  )
}))

import { SectionBody } from './settings-section'

function renderSection(section: string) {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <SectionBody section={section} />
      </ThemeProvider>
    </I18nProvider>
  )
}

describe('SectionBody desktop subpage routing', () => {
  it('routes gateway pages to GatewaySettings including connection', () => {
    const { unmount: u1 } = renderSection('gateway')
    expect(screen.getByTestId('gateway-settings').getAttribute('data-subpage')).toBe('connection')
    u1()

    const { unmount: u2 } = renderSection('gateway/connection')
    expect(screen.getByTestId('gateway-settings').getAttribute('data-subpage')).toBe('connection')
    u2()

    const { unmount: u3 } = renderSection('gateway/devices')
    expect(screen.getByTestId('gateway-settings').getAttribute('data-subpage')).toBe('devices')
    u3()

    renderSection('gateway/managed-updates')
    expect(screen.getByTestId('gateway-settings').getAttribute('data-subpage')).toBe('managed-updates')
  })

  it('routes appearance subpages to AppearanceSettings', () => {
    renderSection('appearance/theme')
    expect(screen.getByTestId('appearance-settings').getAttribute('data-subpage')).toBe('theme')
  })

  it('routes config sections to ConfigSettings with section id and subpage', () => {
    const { unmount: u1 } = renderSection('model/auxiliary')
    const model = screen.getByTestId('config-settings')
    expect(model.getAttribute('data-section')).toBe('model')
    expect(model.getAttribute('data-subpage')).toBe('auxiliary')
    u1()

    const { unmount: u2 } = renderSection('safety/approvals')
    const safety = screen.getByTestId('config-settings')
    expect(safety.getAttribute('data-section')).toBe('safety')
    expect(safety.getAttribute('data-subpage')).toBe('approvals')
    u2()

    renderSection('browser/network')
    const browser = screen.getByTestId('config-settings')
    expect(browser.getAttribute('data-section')).toBe('browser')
    expect(browser.getAttribute('data-subpage')).toBe('network')
  })

  it('passes OTHER_SUBPAGES segments to settings bodies', () => {
    const { unmount: u1 } = renderSection('shortcuts/hud-gesture')
    expect(screen.getByTestId('keybind-settings').getAttribute('data-subpage')).toBe('hud-gesture')
    u1()

    const { unmount: u2 } = renderSection('notifications/sounds')
    expect(screen.getByTestId('notifications-settings').getAttribute('data-subpage')).toBe('sounds')
    u2()

    const { unmount: u3 } = renderSection('sessions/default-directory')
    expect(screen.getByTestId('sessions-settings').getAttribute('data-subpage')).toBe('default-directory')
    u3()

    renderSection('about/uninstall')
    expect(screen.getByTestId('about-settings').getAttribute('data-subpage')).toBe('uninstall')
  })
})
