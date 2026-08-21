import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

const session = (over: Partial<SessionInfo>): SessionInfo =>
  ({
    id: 'x',
    title: null,
    preview: null,
    message_count: 0,
    ended_at: null,
    input_tokens: 0,
    archived: true,
    ...over
  }) as SessionInfo

vi.mock('@/hermes', () => ({
  listSessions: vi.fn(async () => ({
    sessions: [
      session({ id: 's1', title: 'Old chat', message_count: 3 }),
      session({ id: 's2', title: 'Another', message_count: 1 })
    ],
    total: 2,
    offset: 0
  })),
  setSessionArchived: vi.fn(async () => ({ ok: true })),
  deleteSession: vi.fn(async () => ({ ok: true })),
  getDefaultCwd: vi.fn(async () => ({ cwd: '/home/u', branch: null }))
}))
// `isSessionPinned` is exercised for real in store/session.test.ts (it reads
// the backend flag AND the lineage-root-keyed local pin set). Here it is a
// controllable stub: what this file has to prove is that the dialog renders the
// keep-flag warning exactly when the predicate says the row is pinned.
vi.mock('@/store/session', () => ({
  refreshSessions: vi.fn(async () => undefined),
  isSessionPinned: vi.fn(() => false)
}))
vi.mock('@/store/projects', () => ({ pickProjectFolder: vi.fn(async () => null) }))

import { MemoryRouter } from 'react-router-dom'

import { deleteSession, setSessionArchived } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { isSessionPinned } from '@/store/session'

import { ArchivedSection } from './archived-section'

const unarchive = vi.mocked(setSessionArchived)
const pinned = vi.mocked(isSessionPinned)

const PINNED_WARNING =
  'This chat is pinned. Pinning marks it as kept — bulk cleanups skip it, but deleting it here is permanent.'

/** Open the permanent-delete confirm on the first archived row. */
const openDeleteConfirm = async () => {
  renderSection()
  await screen.findByText('Old chat')
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete permanently' })[0])
}

// Router context: the section reads ?session= for palette deep links.
const renderSection = () =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <ArchivedSection />
      </I18nProvider>
    </MemoryRouter>
  )

describe('ArchivedSection', () => {
  beforeEach(() => {
    unarchive.mockClear()
    pinned.mockReset()
    pinned.mockReturnValue(false)
  })
  afterEach(() => localStorage.clear())

  it('lists archived sessions', async () => {
    renderSection()
    expect(await screen.findByText('Old chat')).toBeInTheDocument()
    expect(screen.getByText('Another')).toBeInTheDocument()
  })

  it('unarchives a session and removes it from the list', async () => {
    renderSection()
    await screen.findByText('Old chat')
    fireEvent.click(screen.getAllByRole('button', { name: 'Unarchive' })[0])
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith('s1', false))
    await waitFor(() => expect(screen.queryByText('Old chat')).not.toBeInTheDocument())
  })

  it('warns that the row carries the keep flag before deleting it', async () => {
    pinned.mockReturnValue(true)
    await openDeleteConfirm()
    expect(await screen.findByText(PINNED_WARNING)).toBeInTheDocument()
  })

  it('does not warn for an unpinned row', async () => {
    // The confirm still opens — only the extra line is conditional.
    await openDeleteConfirm()
    expect(await screen.findByText('Permanently delete "Old chat"? This cannot be undone.')).toBeInTheDocument()
    expect(screen.queryByText(PINNED_WARNING)).not.toBeInTheDocument()
  })

  it('asks about the row it is about to delete, not the first one', async () => {
    pinned.mockImplementation(session => session.id === 's2')
    renderSection()
    await screen.findByText('Another')
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete permanently' })[1])
    expect(await screen.findByText(PINNED_WARNING)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete permanently' })[0])
    await waitFor(() => expect(screen.queryByText(PINNED_WARNING)).not.toBeInTheDocument())
  })

  it('still deletes when the user confirms past the warning', async () => {
    pinned.mockReturnValue(true)
    await openDeleteConfirm()
    await screen.findByText(PINNED_WARNING)
    const buttons = screen.getAllByRole('button', { name: 'Delete permanently' })
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(vi.mocked(deleteSession)).toHaveBeenCalledWith('s1'))
  })
})
