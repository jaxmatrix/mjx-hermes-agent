import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { $commandMenuOpen } from '@/store/command-menu'

import { CommandMenu } from './command-menu'

const renderMenu = () =>
  render(
    <MemoryRouter>
      <CommandMenu />
    </MemoryRouter>
  )

afterEach(() => $commandMenuOpen.set(false))

describe('CommandMenu', () => {
  it('lists the non-rail views when open and filters by query', () => {
    $commandMenuOpen.set(true)
    renderMenu()

    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Starmap')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'star' } })
    expect(screen.getByText('Starmap')).toBeInTheDocument()
    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
  })

  it('toggles open on ⌘K / Ctrl+K', () => {
    renderMenu()
    expect($commandMenuOpen.get()).toBe(false)

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect($commandMenuOpen.get()).toBe(true)
  })
})
