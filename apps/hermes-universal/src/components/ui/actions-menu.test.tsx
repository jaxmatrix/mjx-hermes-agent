import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActionsContextMenu, ActionsMenu, type MenuKit } from './actions-menu'

const platform = vi.hoisted(() => ({ IS_MOBILE: false }))

vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get IS_MOBILE() {
    return platform.IS_MOBILE
  }
}))

afterEach(() => {
  cleanup()
  platform.IS_MOBILE = false
})

it.each(['dropdown', 'context'] as const)('defers %s items until opened and reads the latest actions', async kind => {
  const selected = vi.fn()
  const items = vi.fn((kit: MenuKit) => <kit.Item onSelect={selected}>Original action</kit.Item>)
  const nextItems = vi.fn((kit: MenuKit) => <kit.Item onSelect={selected}>Latest action</kit.Item>)
  const Menu = kind === 'dropdown' ? ActionsMenu : ActionsContextMenu

  const view = (renderItems: typeof items) => (
    <Menu items={renderItems}>
      <button type="button">Actions</button>
    </Menu>
  )

  const { rerender } = render(view(items))
  expect(items).not.toHaveBeenCalled()
  rerender(view(nextItems))
  expect(nextItems).not.toHaveBeenCalled()

  const trigger = screen.getByRole('button', { name: 'Actions' })

  if (kind === 'dropdown') {
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  } else {
    fireEvent.contextMenu(trigger, { clientX: 20, clientY: 20 })
  }

  fireEvent.click(await screen.findByRole('menuitem', { name: 'Latest action' }))
  expect(selected).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  const callsAfterClose = nextItems.mock.calls.length
  rerender(view(nextItems))
  expect(nextItems).toHaveBeenCalledTimes(callsAfterClose)
})

describe('mobile bottom drawer', () => {
  beforeEach(() => {
    platform.IS_MOBILE = true
  })

  it('opens ActionsMenu as a bottom sheet', async () => {
    const selected = vi.fn()
    const items = vi.fn((kit: MenuKit) => (
      <kit.Item onSelect={selected}>
        <span>Pin</span>
      </kit.Item>
    ))

    render(
      <ActionsMenu ariaLabel="Session actions" items={items}>
        <button type="button">Actions</button>
      </ActionsMenu>
    )

    expect(items).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Session actions')).toBeTruthy()
    expect(document.querySelector('[data-menu-drawer]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    expect(selected).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens ActionsContextMenu as a bottom sheet on contextmenu', async () => {
    const selected = vi.fn()
    const items = vi.fn((kit: MenuKit) => (
      <kit.Item onSelect={selected}>
        <span>Rename</span>
      </kit.Item>
    ))

    render(
      <ActionsContextMenu ariaLabel="Row actions" items={items}>
        <button type="button">Row</button>
      </ActionsContextMenu>
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Row' }), { clientX: 20, clientY: 20 })

    expect(await screen.findByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(selected).toHaveBeenCalledTimes(1)
  })
})
