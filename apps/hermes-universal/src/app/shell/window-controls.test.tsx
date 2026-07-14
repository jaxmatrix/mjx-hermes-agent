import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

// Fake Tauri window — spies for each control + a settable maximized state.
const win = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn().mockResolvedValue(false),
  onResized: vi.fn().mockResolvedValue(() => {})
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }))

import { WindowControls } from './window-controls'

const renderControls = () =>
  render(
    <I18nProvider>
      <WindowControls />
    </I18nProvider>
  )

describe('WindowControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    win.isMaximized.mockResolvedValue(false)
    win.onResized.mockResolvedValue(() => {})
  })

  it('wires the three buttons to the window API', () => {
    renderControls()
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(win.minimize).toHaveBeenCalledOnce()
    expect(win.toggleMaximize).toHaveBeenCalledOnce()
    expect(win.close).toHaveBeenCalledOnce()
  })

  it('shows the restore glyph/label when the window is maximized', async () => {
    win.isMaximized.mockResolvedValue(true)
    renderControls()
    // Effect resolves isMaximized → the middle button relabels to Restore.
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })
})
