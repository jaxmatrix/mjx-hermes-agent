import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { StatusbarControls, type StatusbarItem } from './statusbar-controls'

const renderBar = (leftItems: StatusbarItem[] = [], items: StatusbarItem[] = []) =>
  render(
    <MemoryRouter>
      <StatusbarControls items={items} leftItems={leftItems} />
    </MemoryRouter>
  )

describe('StatusbarControls renderer', () => {
  it('paints a two-group footer with the statusbar tokens + responsive height', () => {
    const { container } = renderBar()
    const footer = container.querySelector('[data-slot="statusbar"]') as HTMLElement

    expect(footer).toBeTruthy()
    // taller touch bar on phones, compact 20px chrome bar on md+
    expect(footer.className).toContain('h-8')
    expect(footer.className).toContain('md:h-5')
    expect(footer.className).toContain('border-t')
    expect(footer.className).toContain('bg-(--ui-sidebar-surface-background)')
  })

  it('filters hidden items out of both groups', () => {
    renderBar([
      { id: 'shown', label: 'Shown', variant: 'action' },
      { id: 'gone', hidden: true, label: 'Hidden', variant: 'action' }
    ])

    expect(screen.getByText('Shown')).toBeInTheDocument()
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
  })

  it('renders a text item as a non-interactive label + detail (no button)', () => {
    renderBar([], [{ detail: '1:23', id: 't', label: 'Session', variant: 'text' }])

    expect(screen.getByText('Session')).toBeInTheDocument()
    expect(screen.getByText('1:23')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('fires onSelect with the shift modifier on an action click', () => {
    const onSelect = vi.fn()
    renderBar([{ id: 'a', label: 'Act', onSelect, variant: 'action' }])

    fireEvent.click(screen.getByText('Act'), { shiftKey: true })

    expect(onSelect).toHaveBeenCalledWith({ shiftKey: true })
  })

  it('renders a menu trigger button for a menu item', () => {
    renderBar([], [{ id: 'm', label: 'Menu', menuContent: <div>panel</div>, variant: 'menu' }])

    expect(screen.getByRole('button', { name: /Menu/ })).toBeInTheDocument()
  })
})
