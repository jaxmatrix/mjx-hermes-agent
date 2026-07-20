import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $capture, bindingsFor, resetAllBindings } from '@/store/keybinds'

import { KeybindSettings } from './keybind-settings'

const renderPanel = () =>
  render(
    <I18nProvider>
      <KeybindSettings />
    </I18nProvider>
  )

afterEach(() => {
  $capture.set(null)
  resetAllBindings()
})

describe('KeybindSettings', () => {
  it('renders the categories with their rebindable and readonly rows', () => {
    renderPanel()

    expect(screen.getByText('Composer')).toBeInTheDocument()
    expect(screen.getByText('Toggle sessions sidebar')).toBeInTheDocument()
    // A fixed, non-rebindable composer shortcut still appears for discoverability.
    expect(screen.getByText('Steer the running turn')).toBeInTheDocument()
  })

  it('filters rows by the search query', () => {
    renderPanel()

    fireEvent.change(screen.getByPlaceholderText('Search shortcuts…'), { target: { value: 'terminal' } })

    expect(screen.getByText('Toggle terminal')).toBeInTheDocument()
    expect(screen.queryByText('Toggle sessions sidebar')).not.toBeInTheDocument()
  })

  it('arms capture mode when a row’s keycaps are clicked', () => {
    renderPanel()

    const row = screen.getByText('Toggle sessions sidebar').closest('div')
    const rebind = row?.querySelector('button[aria-label="Rebind"]')
    fireEvent.click(rebind as Element)

    expect($capture.get()).toBe('view.toggleSidebar')
    expect(screen.getByText('Press a key…')).toBeInTheDocument()
  })

  it('resets every binding back to its shipped default', () => {
    renderPanel()

    fireEvent.click(screen.getByText('Reset all'))
    expect(bindingsFor('view.toggleSidebar')).toEqual(['mod+b'])
  })
})
