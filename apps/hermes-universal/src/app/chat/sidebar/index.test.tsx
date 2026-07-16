import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { $panesFlipped, setSidebarOpen } from '@/store/layout'

import { ChatSidebar, type ChatSidebarProps } from './index'

const renderSidebar = (props: ChatSidebarProps = {}) =>
  render(
    <MemoryRouter>
      <ChatSidebar {...props} />
    </MemoryRouter>
  )

afterEach(() => {
  setSidebarOpen(true)
  $panesFlipped.set(false)
})

describe('ChatSidebar (pane) — the sidebar↔main division', () => {
  it('paints the surface + edge border on the right edge when open', () => {
    setSidebarOpen(true)
    const { container } = renderSidebar({ variant: 'pane' })
    const root = container.firstChild as HTMLElement

    expect(root.className).toContain('bg-(--ui-sidebar-surface-background)')
    expect(root.className).toContain('border-(--sidebar-edge-border)')
    expect(root.className).toContain('border-r')
    expect(screen.getByText('New session')).toBeInTheDocument()
  })

  it('goes transparent + non-interactive when closed (main shows through)', () => {
    setSidebarOpen(false)
    const { container } = renderSidebar({ variant: 'pane' })
    const root = container.firstChild as HTMLElement

    expect(root.className).toContain('bg-transparent')
    expect(root.className).toContain('opacity-0')
    expect(root.className).toContain('pointer-events-none')
  })

  it('mirrors the border to the left edge when panes are flipped', () => {
    setSidebarOpen(true)
    $panesFlipped.set(true)
    const { container } = renderSidebar({ variant: 'pane' })
    const root = container.firstChild as HTMLElement

    expect(root.className).toContain('border-l')
  })
})
