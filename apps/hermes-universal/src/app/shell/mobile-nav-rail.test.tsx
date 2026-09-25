import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MobileNavRail, type MobileNavRailItem } from './mobile-nav-rail'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: () => undefined }))

function items(count: number): MobileNavRailItem[] {
  return Array.from({ length: count }, (_, i) => ({
    icon: 'robot',
    id: `item-${i}`,
    label: `Item ${i}`,
    onSelect: () => undefined
  }))
}

describe('MobileNavRail', () => {
  it('paints the sidebar surface (same role as desktop statusbar)', () => {
    const { container } = render(<MobileNavRail aria-label="Nav" items={items(2)} />)
    const rail = container.querySelector('[data-slot="mobile-nav-rail"]') as HTMLElement

    expect(rail.className).toContain('bg-(--ui-bg-sidebar)')
    expect(rail.className).toContain('border-(--ui-stroke-tertiary)')
  })

  it('fills the rail width when there are four or fewer items', () => {
    render(<MobileNavRail aria-label="Nav" items={items(4)} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(4)
    for (const button of buttons) {
      expect(button.getAttribute('data-fill')).toBe('true')
      expect(button.className).toMatch(/flex-1/)
      expect(button.className).toMatch(/min-h-12/)
      expect(button.className).not.toMatch(/shrink-0/)
    }
  })

  it('keeps items scrollable at 25% rail cell width when there are more than four', () => {
    const { container } = render(<MobileNavRail aria-label="Nav" items={items(5)} />)

    const row = container.querySelector('[data-slot="mobile-nav-rail"] > div')
    expect(row?.className).toMatch(/overflow-x-auto/)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(5)
    for (const button of buttons) {
      expect(button.getAttribute('data-fill')).toBe('false')
      expect(button.className).toMatch(/shrink-0/)
      expect(button.className).toMatch(/basis-1\/4/)
      expect(button.className).toMatch(/min-w-\[25%\]/)
      expect(button.className).toMatch(/min-h-12/)
      expect(button.className).not.toMatch(/flex-1/)
    }
  })

  it('uses ariaLabel for accessibility when it differs from the visible label', () => {
    render(
      <MobileNavRail
        aria-label="Nav"
        items={[
          {
            ariaLabel: 'New session',
            icon: 'robot',
            id: 'new-session',
            label: 'New',
            onSelect: () => undefined
          }
        ]}
      />
    )

    expect(screen.getByLabelText('New session')).toBeTruthy()
    expect(screen.getByText('New')).toBeTruthy()
  })
})
