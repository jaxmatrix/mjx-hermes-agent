import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import { ShortcutsSection } from './shortcuts-section'

describe('ShortcutsSection', () => {
  it('lists the composer keyboard shortcuts', () => {
    render(
      <I18nProvider>
        <ShortcutsSection />
      </I18nProvider>
    )
    expect(screen.getByText('Send message')).toBeInTheDocument()
    expect(screen.getByText('⌘/Ctrl + ↵')).toBeInTheDocument()
    expect(screen.getByText('New line')).toBeInTheDocument()
    expect(screen.getByText('Previous / next message')).toBeInTheDocument()
    expect(screen.getByText('Dismiss suggestions')).toBeInTheDocument()
  })
})
