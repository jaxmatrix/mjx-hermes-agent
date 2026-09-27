import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { RootTooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/themes'

import { MobileWindowChrome } from './mobile-window-chrome'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: () => undefined }))

function renderChrome(ui: ReactElement) {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <RootTooltipProvider>
          <div style={{ height: 400 }}>{ui}</div>
        </RootTooltipProvider>
      </ThemeProvider>
    </I18nProvider>
  )
}

describe('MobileWindowChrome', () => {
  it('keeps an in-flow top bar with close when there are no tabs', () => {
    const { container } = renderChrome(<MobileWindowChrome body={<div>Body</div>} onClose={() => undefined} />)

    const top = container.querySelector('[data-slot="mobile-window-top"]')
    expect(top).toBeTruthy()
    expect(top?.querySelector('[data-top-bar]')?.className).toMatch(/\bh-12\b/)
    expect(container.querySelector('[data-slot="mobile-window-close-float"]')).toBeNull()
    expect(screen.getByLabelText(/close/i).getAttribute('data-density')).toBe('mobile')
  })

  it('paints the solid sidebar seed so Sessions/Workspace match desktop sidebar', () => {
    const { container } = renderChrome(<MobileWindowChrome body={<div>Body</div>} onClose={() => undefined} />)

    const window = container.querySelector('[data-slot="mobile-window"]') as HTMLElement
    expect(window.className).toContain('bg-(--ui-bg-sidebar)')
    expect(window.hasAttribute('data-glass-opaque')).toBe(false)
  })

  it('keeps an h-12 row when tabs are present', () => {
    const { container } = renderChrome(
      <MobileWindowChrome
        activeTabId="a"
        body={<div>Body</div>}
        onClose={() => undefined}
        onSelectTab={() => undefined}
        tabs={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' }
        ]}
      />
    )

    const row = container.querySelector('[data-slot="mobile-window-top"] [data-top-bar]')
    expect(row?.className).toMatch(/\bh-12\b/)
    expect(container.querySelector('[data-slot="mobile-window-close-float"]')).toBeNull()
    expect(screen.getByLabelText(/close/i).getAttribute('data-density')).toBe('mobile')
  })
})
