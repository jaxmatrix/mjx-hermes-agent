import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '1.2.3') }))

import { I18nProvider } from '@/i18n'

import { AboutSection } from './about-section'

describe('AboutSection', () => {
  it('shows the app version and a release-notes link', async () => {
    render(
      <I18nProvider>
        <AboutSection />
      </I18nProvider>
    )
    expect(await screen.findByText('Version 1.2.3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Release notes' })).toBeInTheDocument()
  })
})
