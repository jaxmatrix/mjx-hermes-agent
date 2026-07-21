import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $panesFlipped, $rightSidebarOpen, $sidebarOpen, setSidebarOpen } from '@/store/layout'

// The titlebar mounts WindowControls, which reaches for the real Tauri window.
const win = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn().mockResolvedValue(false),
  onResized: vi.fn().mockResolvedValue(() => {})
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }))

import { Titlebar } from './titlebar'

const renderTitlebar = () =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <Titlebar connected />
      </I18nProvider>
    </MemoryRouter>
  )

afterEach(() => {
  setSidebarOpen(true)
  $rightSidebarOpen.set(false)
  $panesFlipped.set(false)
})

describe('Titlebar sidebar toggles', () => {
  it('drives the chat sidebar / file rails by identity while unflipped', () => {
    setSidebarOpen(true)
    $rightSidebarOpen.set(false)
    renderTitlebar()

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    expect($sidebarOpen.get()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Show right sidebar' }))
    expect($rightSidebarOpen.get()).toBe(true)
  })

  // The bug: after a swap the left button used to keep hiding the chat sidebar,
  // which had moved to the right edge. Toggles are positional now.
  it('follows the swap — the left button drives whatever sits on the left', () => {
    setSidebarOpen(true)
    $rightSidebarOpen.set(false)
    $panesFlipped.set(true)
    renderTitlebar()

    // Left cluster now faces the file rails (closed) → "Show sidebar".
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    expect($rightSidebarOpen.get()).toBe(true)
    expect($sidebarOpen.get()).toBe(true)

    // Right cluster now faces the chat sidebar (open) → "Hide right sidebar".
    fireEvent.click(screen.getByRole('button', { name: 'Hide right sidebar' }))
    expect($sidebarOpen.get()).toBe(false)
    expect($rightSidebarOpen.get()).toBe(true)
  })
})
