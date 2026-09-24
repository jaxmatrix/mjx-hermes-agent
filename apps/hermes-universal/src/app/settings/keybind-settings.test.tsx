import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { globalKeybindActions } from '@/lib/keybinds/actions'
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

  // OS-global chords are declared in lib/keybinds/actions (not painted as a
  // "System-wide" badge in the panel anymore). The HUD toggle is the only one.
  it('keeps the OS-global HUD shortcut in the map, and only that one', () => {
    renderPanel()

    expect(screen.getByText('Toggle HUD mode')).toBeInTheDocument()
    expect(globalKeybindActions().map(a => a.id)).toEqual(['view.toggleHud'])
  })

  it('resets every binding back to its shipped default', () => {
    renderPanel()

    fireEvent.click(screen.getByText('Reset all'))
    expect(bindingsFor('view.toggleSidebar')).toEqual(['mod+b'])
  })
})
