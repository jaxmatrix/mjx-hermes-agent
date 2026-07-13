import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { NAV_ITEMS } from './nav-items'
import { AppShell, SidebarProvider } from './sidebar'

function renderShell(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <SidebarProvider>
        <AppShell>
          <div>content</div>
        </AppShell>
      </SidebarProvider>
    </MemoryRouter>
  )
}

describe('sidebar shell', () => {
  it('renders every nav item as a link with its route (rail is always mounted)', () => {
    renderShell()
    for (const item of NAV_ITEMS) {
      const links = screen.getAllByRole('link', { name: new RegExp(item.label, 'i') })
      expect(links.length).toBeGreaterThan(0)
      expect(links[0]).toHaveAttribute('href', item.path) // MemoryRouter → plain path (HashRouter adds #)
    }
  })

  it('marks the active route with aria-current', () => {
    renderShell('/settings')
    const settings = screen.getAllByRole('link', { name: /settings/i })[0]
    expect(settings).toHaveAttribute('aria-current', 'page')
  })

  it('renders the routed content', () => {
    renderShell()
    expect(screen.getByText('content')).toBeInTheDocument()
  })
})
