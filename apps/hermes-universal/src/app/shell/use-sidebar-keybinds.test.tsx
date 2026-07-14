import { fireEvent, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { $sidebarOpen, setSidebarOpen } from '@/store/layout'

import { useSidebarKeybinds } from './use-sidebar-keybinds'

function Harness() {
  useSidebarKeybinds()
  return null
}

afterEach(() => setSidebarOpen(true))

describe('useSidebarKeybinds', () => {
  it('toggles the sidebar on mod+b', () => {
    setSidebarOpen(true)
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    )

    fireEvent.keyDown(window, { key: 'b', metaKey: true })
    expect($sidebarOpen.get()).toBe(false)

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect($sidebarOpen.get()).toBe(true)
  })

  it('ignores a bare "b" without a modifier', () => {
    setSidebarOpen(true)
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    )

    fireEvent.keyDown(window, { key: 'b' })
    expect($sidebarOpen.get()).toBe(true)
  })
})
