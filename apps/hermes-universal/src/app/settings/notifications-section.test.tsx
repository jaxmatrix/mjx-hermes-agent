import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $nativeNotifyPrefs } from '@/store/native-notifications'

import { NotificationsSection } from './notifications-section'

const DEFAULTS = {
  enabled: true,
  kinds: { approval: true, backgroundDone: true, input: true, turnDone: true, turnError: true }
}

function renderSection() {
  return render(
    <I18nProvider>
      <NotificationsSection />
    </I18nProvider>
  )
}

describe('NotificationsSection', () => {
  beforeEach(() => {
    localStorage.clear()
    $nativeNotifyPrefs.set({ ...DEFAULTS, kinds: { ...DEFAULTS.kinds } })
  })
  afterEach(() => localStorage.clear())

  it('renders the master switch + a switch per kind + the haptics toggle', () => {
    renderSection()
    expect(screen.getByText('Enable notifications')).toBeInTheDocument()
    // master + 5 kinds + haptics = 7 switches
    expect(screen.getAllByRole('switch')).toHaveLength(7)
  })

  it('toggles the master enabled flag through the store', () => {
    renderSection()
    const master = screen.getAllByRole('switch')[0]
    fireEvent.click(master)
    expect($nativeNotifyPrefs.get().enabled).toBe(false)
  })
})
