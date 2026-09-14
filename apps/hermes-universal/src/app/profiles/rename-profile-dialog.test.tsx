import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({ renameProfile: vi.fn(async () => ({ name: 'default', ok: true, path: '/h' })) }))

import { renameProfile } from '@/hermes'
import { I18nProvider } from '@/i18n'

import { RenameProfileDialog } from './rename-profile-dialog'

const rename = vi.mocked(renameProfile)

const open = (isDefault: boolean, currentName = 'default') => {
  const onRenamed = vi.fn()

  render(
    <I18nProvider>
      <RenameProfileDialog
        currentName={currentName}
        isDefault={isDefault}
        onClose={vi.fn()}
        onRenamed={onRenamed}
        open
      />
    </I18nProvider>
  )

  return onRenamed
}

const field = () => screen.getByLabelText(/Display name|New name/) as HTMLInputElement

const submit = () => fireEvent.submit(field().closest('form') as HTMLFormElement)

afterEach(() => {
  rename.mockClear()
})

describe('RenameProfileDialog display-name mode', () => {
  // "default" is the profile ID, not a name — pre-filling it would have the
  // user delete it before typing, and submitting it unchanged is meaningless.
  it('starts blank and offers the display-name copy for the default profile', () => {
    open(true)

    expect(field().value).toBe('')
    expect(screen.getByText('Name this agent')).toBeTruthy()
  })

  // The canonical id is what goes on the wire; the backend turns a rename of
  // "default" into a profile.yaml display_name. A named profile still moves.
  it('sends the canonical id with the free-text display name', async () => {
    open(true)

    fireEvent.change(field(), { target: { value: 'Ada Lovelace' } })
    submit()

    await waitFor(() => expect(rename).toHaveBeenCalledWith('default', 'Ada Lovelace'))
  })

  // Slug rules are a NAMED-profile constraint (the directory move); a display
  // name is presentation only, so spaces and Unicode must not be rejected.
  it('accepts a name the slug rules would reject, and drops the slug hint', async () => {
    open(true)

    fireEvent.change(field(), { target: { value: 'Ada 💡' } })

    expect(screen.queryByText(/Lowercase letters/i)).toBeNull()
    submit()

    await waitFor(() => expect(rename).toHaveBeenCalledWith('default', 'Ada 💡'))
  })

  it('still enforces the slug rules for a named profile', async () => {
    open(false, 'research')

    fireEvent.change(field(), { target: { value: 'Ada 💡' } })
    submit()

    await waitFor(() => expect(screen.getByText(/Invalid name/i)).toBeTruthy())
    expect(rename).not.toHaveBeenCalled()
  })
})
