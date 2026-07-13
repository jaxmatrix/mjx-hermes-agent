import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FsEntry } from '@/types/hermes'

const entry = (name: string, isDirectory: boolean, path = `/work/${name}`): FsEntry => ({ name, path, isDirectory })

vi.mock('@/hermes', () => ({
  getDefaultCwd: vi.fn(async () => ({ cwd: '/work', branch: 'main' })),
  readDir: vi.fn(async () => ({
    // Intentionally unsorted; the screen sorts dirs-first then alpha.
    entries: [entry('readme.md', false), entry('src', true), entry('assets', true)]
  })),
  readFileText: vi.fn(async () => ({ path: '', text: '' }))
}))

import { readDir } from '@/hermes'
import { I18nProvider } from '@/i18n'

import { SidebarProvider } from '@/app/shell/sidebar'

import { FilesScreen } from './files-screen'

const list = vi.mocked(readDir)

const renderScreen = () =>
  render(
    <I18nProvider>
      <SidebarProvider>
        <FilesScreen />
      </SidebarProvider>
    </I18nProvider>
  )

describe('FilesScreen', () => {
  beforeEach(() => list.mockClear())
  afterEach(() => vi.restoreAllMocks())

  it('lists the default cwd with folders first', async () => {
    renderScreen()
    await screen.findByText('src')
    const labels = screen.getAllByText(/^(assets|src|readme\.md)$/).map(n => n.textContent)
    expect(labels).toEqual(['assets', 'src', 'readme.md']) // dirs (alpha) then files
  })

  it('navigates into a folder on tap', async () => {
    renderScreen()
    fireEvent.click(await screen.findByText('src'))
    await waitFor(() => expect(list).toHaveBeenCalledWith('/work/src'))
  })
})
