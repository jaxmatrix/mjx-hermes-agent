import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppShell, SidebarProvider } from './sidebar'

// jsdom has no matchMedia; stub it per-test so we can exercise both the docked
// pane (wide) and the drawer (narrow) branches of the responsive AppShell.
function mockViewport(wide: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: wide,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

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

afterEach(() => {
  // @ts-expect-error — remove the stub between tests
  delete window.matchMedia
})

describe('sidebar shell', () => {
  it('renders the routed content in the drawer (narrow) layout', () => {
    mockViewport(false)
    renderShell()
    expect(screen.getByText('content')).toBeInTheDocument()
  })

  it('mounts the docked chat sidebar alongside content on wide viewports', () => {
    mockViewport(true)
    renderShell()
    expect(screen.getByText('content')).toBeInTheDocument()
    // The docked pane is open by default, so the sidebar nav rail is present.
    expect(screen.getByText('New session')).toBeInTheDocument()
    expect(screen.getByText('Capabilities')).toBeInTheDocument()
  })
})
