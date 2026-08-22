/**
 * The Thinking toggle must not be offered where the route rejects a disable.
 *
 * Some routes take no reasoning parameter at all, and some take one they will
 * not let you turn off — the provider catalog marks those "mandatory", and the
 * inventory forwards it as `can_disable_reasoning: false`. Switching the toggle
 * there is an HTTP 400, so the control could only ever fail. Desktop hid it in
 * `d15cd18fa1`; universal never read the field.
 *
 * `undefined` is the third state and the reason every read is `!== false`: a
 * catalog that says nothing must keep offering the toggle, or every provider
 * without reasoning metadata silently loses it.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DropdownMenu, DropdownMenuContent, DropdownMenuSub } from '@/components/ui/dropdown-menu'
import { I18nProvider } from '@/i18n'
import { en } from '@/i18n/en'

import { ModelEditSubmenu } from './model-edit-submenu'

const renderSubmenu = (props: { canDisableReasoning?: boolean; reasoning?: boolean }) =>
  render(
    <I18nProvider>
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <ModelEditSubmenu
              effort="high"
              fastControl={{ kind: 'none' }}
              isActive
              onSelectModel={vi.fn()}
              onSetOptions={vi.fn()}
              reasoning
              {...props}
            />
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </I18nProvider>
  )

afterEach(cleanup)

describe('ModelEditSubmenu thinking toggle', () => {
  it('offers it when the catalog says nothing', () => {
    renderSubmenu({})

    expect(screen.getByText(en.shell.modelOptions.thinking)).toBeTruthy()
  })

  it('offers it when the catalog says the route allows a disable', () => {
    renderSubmenu({ canDisableReasoning: true })

    expect(screen.getByText(en.shell.modelOptions.thinking)).toBeTruthy()
  })

  it('hides it for a route that rejects a disable', () => {
    renderSubmenu({ canDisableReasoning: false })

    expect(screen.queryByText(en.shell.modelOptions.thinking)).toBeNull()
    // The effort scale is a different question: the model still reasons, it
    // just cannot be asked to stop.
    expect(screen.getByText(en.shell.modelOptions.effort)).toBeTruthy()
    expect(screen.getByText(en.shell.modelOptions.ultra)).toBeTruthy()
  })

  it('hides it for a model with no reasoning at all', () => {
    renderSubmenu({ canDisableReasoning: true, reasoning: false })

    expect(screen.queryByText(en.shell.modelOptions.thinking)).toBeNull()
  })
})
