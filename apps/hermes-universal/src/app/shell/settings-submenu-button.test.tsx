import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { RootTooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/themes'

import { SettingsSubmenuButton } from './settings-submenu-button'

function renderButton(selectedId = 'providers') {
  const onSelect = vi.fn()

  const view = render(
    <I18nProvider>
      <ThemeProvider>
        <RootTooltipProvider>
          <SettingsSubmenuButton
            onSelect={onSelect}
            options={[
              { id: 'providers', label: 'Accounts' },
              { id: 'providers/keys', label: 'API keys' },
              { id: 'providers/custom-endpoints', label: 'Custom endpoints' }
            ]}
            selectedId={selectedId}
            title="Providers"
          />
        </RootTooltipProvider>
      </ThemeProvider>
    </I18nProvider>
  )

  return { onSelect, ...view }
}

describe('SettingsSubmenuButton', () => {
  it('shows the current option on the trigger and in the drawer', async () => {
    const user = userEvent.setup()
    const { container } = renderButton('providers/keys')

    const trigger = container.querySelector('[data-slot="settings-submenu-trigger"]') as HTMLElement
    expect(trigger.textContent).toContain('API keys')

    await user.click(trigger)

    // Every child stays listed — including the one that opened the drawer.
    expect(screen.getByText('Accounts')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'API keys' })).toBeTruthy()
    expect(screen.getByText('Custom endpoints')).toBeTruthy()
  })

  it('selects a child from the drawer', async () => {
    const user = userEvent.setup()
    const { container, onSelect } = renderButton('providers')

    const trigger = container.querySelector('[data-slot="settings-submenu-trigger"]') as HTMLElement
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Custom endpoints' }))

    expect(onSelect).toHaveBeenCalledWith('providers/custom-endpoints')
  })
})
