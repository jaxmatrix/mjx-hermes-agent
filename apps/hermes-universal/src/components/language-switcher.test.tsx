import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import { LanguageSwitcher } from './language-switcher'

function renderSwitcher() {
  return render(
    <I18nProvider>
      <LanguageSwitcher />
    </I18nProvider>
  )
}

describe('LanguageSwitcher', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('shows the active locale on the trigger (English by default)', () => {
    renderSwitcher()
    expect(screen.getByRole('button', { name: 'Switch language' })).toHaveTextContent('English')
  })

  it('opens the menu, lists all four locales, and switches on select', () => {
    renderSwitcher()
    const trigger = screen.getByRole('button', { name: 'Switch language' })

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(trigger)

    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('English')).toBeInTheDocument()
    expect(within(menu).getByText('简体中文')).toBeInTheDocument()
    expect(within(menu).getByText('繁體中文')).toBeInTheDocument()
    expect(within(menu).getByText('日本語')).toBeInTheDocument()

    fireEvent.click(within(menu).getByText('日本語'))

    // Locale persisted + trigger reflects the new selection.
    expect(localStorage.getItem('hermes.locale')).toBe('ja')
    expect(screen.getByRole('button', { name: '言語を切り替え' })).toHaveTextContent('日本語')
  })
})
