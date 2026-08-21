import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { $confirmRequest, type ConfirmAnswer, confirm, settleConfirm } from '@/store/confirm'

import { ConfirmHost } from './confirm-host'

afterEach(() => {
  cleanup()
  $confirmRequest.set(null)
})

const LABELS = { cancelLabel: 'Keep it', confirmLabel: 'Delete forever' }

/**
 * Open a confirm and wait for the dialog, WITHOUT awaiting the answer.
 *
 * `read()` starts as `undefined` — deliberately a third value distinct from both
 * answers, so "the promise never settled" cannot pass as "resolved false".
 */
async function ask(request: Parameters<typeof confirm>[0] = { ...LABELS, title: 'Delete it?' }) {
  let answer: ConfirmAnswer | undefined
  const pending = confirm(request).then(value => (answer = value))

  const dialog = await screen.findByRole('dialog')

  return { dialog, pending, read: () => answer }
}

const button = (name: string) => screen.getByRole('button', { name })

describe('confirm()', () => {
  it('renders nothing until something asks', () => {
    render(<ConfirmHost />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('resolves true when confirmed and false when cancelled', async () => {
    render(<ConfirmHost />)

    const yes = await ask()

    fireEvent.click(button(LABELS.confirmLabel))
    await yes.pending
    expect(yes.read()).toBe(true)

    const no = await ask()

    fireEvent.click(button(LABELS.cancelLabel))
    await no.pending
    expect(no.read()).toBe(false)
  })

  it('is usable with no component of its own — the store answers before anything renders', async () => {
    // The whole point of the front door: a store action calls confirm() and the
    // atom carries the question. No host is rendered in this test at all.
    let answer: ConfirmAnswer | undefined
    const pending = confirm({ title: 'From a store' }).then(value => (answer = value))

    expect($confirmRequest.get()?.title).toBe('From a store')

    settleConfirm(true)
    await pending
    expect(answer).toBe(true)
  })

  describe('focus on open (bb0e9ee95a)', () => {
    it('puts focus on the CONFIRM button, not the close button', async () => {
      render(<ConfirmHost />)

      await ask()

      // Radix's default would take the dialog's X. Asserting "focus is somewhere
      // inside the dialog" would pass on that default, so name the button.
      await waitFor(() => expect(document.activeElement).toBe(button(LABELS.confirmLabel)))
    })

    it('confirms on Enter from wherever focus landed', async () => {
      render(<ConfirmHost />)

      const { dialog, pending, read } = await ask()

      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

      // Aim Enter at CANCEL: the dialog-level handler has to win over the
      // focused button's own activation. jsdom does not synthesise the
      // browser's Enter-to-click, so assert on the mechanism that stops it —
      // fireEvent returns false exactly when preventDefault was called. Drop
      // the preventDefault from ConfirmDialog and this line goes red; asserting
      // only on the resolved value does not, because in jsdom Cancel never
      // fired in the first place.
      const notCancelled = fireEvent.keyDown(button(LABELS.cancelLabel), { key: 'Enter' })

      expect(notCancelled).toBe(false)
      await pending
      expect(read()).toBe(true)
    })

    it('answers no to Escape', async () => {
      render(<ConfirmHost />)

      const { pending, read } = await ask()

      fireEvent.keyDown(document, { key: 'Escape' })

      await pending
      expect(read()).toBe(false)
    })

    it('focuses confirm even when destructive — desktop does not move focus to the safe button', async () => {
      render(<ConfirmHost />)

      await ask({ ...LABELS, destructive: true, title: 'Delete it?' })

      await waitFor(() => expect(document.activeElement).toBe(button(LABELS.confirmLabel)))
    })
  })

  describe('secondary action (5df9cd27ea)', () => {
    it('is absent unless the request asks for one', async () => {
      render(<ConfirmHost />)

      await ask()
      expect(screen.queryByRole('button', { name: 'Archive instead' })).toBeNull()
    })

    it('resolves a value distinct from both true and false', async () => {
      render(<ConfirmHost />)

      const { pending, read } = await ask({ ...LABELS, secondaryLabel: 'Archive instead', title: 'Delete it?' })

      fireEvent.click(button('Archive instead'))

      await pending
      // Not `toBeTruthy` — 'secondary' and true are both truthy, so that would
      // pass if the secondary button simply confirmed.
      expect(read()).toBe('secondary')
    })

    it('is not overwritten by the close that follows it', async () => {
      // ConfirmDialog calls onClose right after secondaryAction.onClick, and
      // onClose settles false. Only settleConfirm's idempotence keeps the
      // answer at 'secondary'.
      render(<ConfirmHost />)

      const { pending, read } = await ask({ ...LABELS, secondaryLabel: 'Archive instead', title: 'Delete it?' })

      fireEvent.click(button('Archive instead'))
      await pending

      settleConfirm(false)
      await Promise.resolve()
      expect(read()).toBe('secondary')
    })
  })

  it('supersedes an open request, answering the one it replaces no', async () => {
    render(<ConfirmHost />)

    const first = await ask({ ...LABELS, title: 'First?' })
    const second = await act(async () => ask({ ...LABELS, title: 'Second?' }))

    await first.pending
    expect(first.read()).toBe(false)
    expect(screen.getByText('Second?')).toBeTruthy()

    fireEvent.click(button(LABELS.confirmLabel))
    await second.pending
    expect(second.read()).toBe(true)
  })

  it('settleConfirm is a no-op with nothing open', () => {
    expect(() => settleConfirm(true)).not.toThrow()
    expect($confirmRequest.get()).toBeNull()
  })

  it('centres on the VISIBLE rectangle so the soft keyboard cannot cover it', async () => {
    render(<ConfirmHost />)

    const { dialog } = await ask()

    // `--visual-viewport-top` is published only by use-keyboard-inset and read
    // only here; a revert to a plain `top-1/2` drops it and this goes red.
    expect(dialog.className).toContain('--visual-viewport-top')
    expect(dialog.className).toContain('--visual-viewport-height')
    expect(dialog.className).not.toContain('top-1/2')
  })
})
