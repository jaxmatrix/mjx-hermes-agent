import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoStatus, RepoStatusFile } from '@/types/hermes'

const file = (path: string, over: Partial<RepoStatusFile> = {}): RepoStatusFile => ({
  path,
  staged: false,
  unstaged: true,
  untracked: false,
  conflicted: false,
  ...over
})

const status = (files: RepoStatusFile[]): RepoStatus => ({
  branch: 'feature/x',
  defaultBranch: 'main',
  detached: false,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: files.length,
  untracked: 0,
  conflicted: 0,
  changed: files.length,
  added: 0,
  removed: 0,
  files
})

vi.mock('@/hermes', () => ({
  getDefaultCwd: vi.fn(async () => ({ cwd: '/repo', branch: 'feature/x' })),
  getRepoStatus: vi.fn(async () => status([file('src/a.ts'), file('README.md', { untracked: true })])),
  getFileDiff: vi.fn(async () => ({ diff: '@@ -1 +1 @@\n-old\n+new' }))
}))

import { getFileDiff } from '@/hermes'
import { I18nProvider } from '@/i18n'

import { SidebarProvider } from '@/app/shell/sidebar'

import { ReviewScreen } from './review-screen'

const diff = vi.mocked(getFileDiff)

const renderScreen = () =>
  render(
    <I18nProvider>
      <SidebarProvider>
        <ReviewScreen />
      </SidebarProvider>
    </I18nProvider>
  )

describe('ReviewScreen', () => {
  beforeEach(() => diff.mockClear())
  afterEach(() => vi.restoreAllMocks())

  it('lists changed files with the branch + count', async () => {
    renderScreen()
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText('feature/x')).toBeInTheDocument()
  })

  it('loads a file diff on tap', async () => {
    renderScreen()
    fireEvent.click(await screen.findByText('src/a.ts'))
    await waitFor(() => expect(diff).toHaveBeenCalledWith('/repo', 'src/a.ts'))
    expect(await screen.findByText('+new')).toBeInTheDocument()
  })
})
