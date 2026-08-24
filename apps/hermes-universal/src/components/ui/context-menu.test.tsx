/**
 * The `2d6d7c550f` marker, and why its POSITION is the fix.
 *
 * Radix `asChild` merges as `mergeProps(slotProps, childProps)`, so a child that
 * sets its own `data-slot` wins. The statusbar does exactly that. The app-wide
 * coordinator stands down for a gesture that lands on the marker — so a trigger
 * whose marker was erased does not degrade, it loses its menu entirely and shows
 * the shell fallback over the statusbar instead.
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HERMES_CONTEXT_MENU_TRIGGER_ATTR, RADIX_TRIGGER_SELECTOR } from '@/app/context-menu/markers'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'

describe('ContextMenuTrigger', () => {
  it('keeps the coordinator marker when the asChild child overwrites data-slot', () => {
    const { container } = render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button data-slot="statusbar" type="button">
            status
          </button>
        </ContextMenuTrigger>
      </ContextMenu>
    )

    const trigger = container.querySelector('button') as HTMLElement

    expect(trigger.getAttribute('data-slot')).toBe('statusbar')
    expect(trigger.hasAttribute(HERMES_CONTEXT_MENU_TRIGGER_ATTR)).toBe(true)
    expect(trigger.closest(RADIX_TRIGGER_SELECTOR)).toBe(trigger)
  })

  it('still carries data-slot when the child does not fight for it', () => {
    const { container } = render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button type="button">row</button>
        </ContextMenuTrigger>
      </ContextMenu>
    )

    const trigger = container.querySelector('button') as HTMLElement

    expect(trigger.getAttribute('data-slot')).toBe('context-menu-trigger')
    expect(trigger.closest(RADIX_TRIGGER_SELECTOR)).toBe(trigger)
  })
})
