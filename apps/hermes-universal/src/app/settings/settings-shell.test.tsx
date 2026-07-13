import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { SidebarProvider } from '@/app/shell/sidebar'
import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'

import { SettingsIndex } from './settings-index'
import { SettingsSection } from './settings-section'

function renderAt(path: string) {
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<SettingsIndex />} path="/settings" />
              <Route element={<SettingsSection />} path="/settings/:section" />
            </Routes>
          </MemoryRouter>
        </SidebarProvider>
      </QueryClientProvider>
    </I18nProvider>
  )
}

describe('settings shell', () => {
  it('lists the config sections + custom rows on the index', () => {
    renderAt('/settings')
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    // A config section, an appearance section, and a custom row all show.
    expect(screen.getByRole('link', { name: /Model/ })).toHaveAttribute('href', '/settings/model')
    expect(screen.getByRole('link', { name: /Appearance/ })).toHaveAttribute('href', '/settings/appearance')
    expect(screen.getByRole('link', { name: /About/ })).toHaveAttribute('href', '/settings/about')
  })

  it('renders a section detail with a back link', () => {
    renderAt('/settings/model')
    expect(screen.getByRole('heading', { name: 'Model' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/settings')
  })
})
