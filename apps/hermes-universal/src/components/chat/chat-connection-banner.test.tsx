/**
 * MJXHRM-591, invariants 39 and 40 — the banner both hosts render.
 *
 * One component, two hosts, two states whose VERBS are the assertion: a lost
 * connection may come back, so it offers Retry; an unavailable tab cannot, so
 * its action list is exactly `['close']`.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ChatConnectionBanner, TranscriptUnavailable } from '@/components/chat/chat-connection-banner'
import { I18nProvider } from '@/i18n'

const show = (node: React.ReactElement) => render(<I18nProvider>{node}</I18nProvider>)

/** Every verb the banner offers, in the order it offers them. */
const actions = () =>
  screen
    .queryAllByRole('button')
    .map(button => (button.textContent ?? '').trim().toLowerCase())
    .map(label => (label.startsWith('close') ? 'close' : label))

describe('a lost connection', () => {
  it('names the connection, and offers exactly Retry', () => {
    const onRetry = vi.fn()

    show(
      <ChatConnectionBanner
        label="deploy box"
        onClose={vi.fn()}
        onRetry={onRetry}
        state={{ connectionId: 'conn-a', kind: 'lost', terminal: false }}
      />
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/deploy box/)).toBeInTheDocument()
    expect(actions()).toEqual(['retry'])

    fireEvent.click(screen.getByRole('button'))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})

describe('an unavailable tab', () => {
  it('offers exactly one verb, and it is Close', () => {
    const onClose = vi.fn()
    const onRetry = vi.fn()

    show(
      <ChatConnectionBanner
        label="deploy box"
        onClose={onClose}
        onRetry={onRetry}
        state={{ kind: 'unavailable', reason: 'backend-changed' }}
      />
    )

    // The action list IS the invariant: a Retry here would ask the user to keep
    // pulling a lever with nothing on the end of it.
    expect(actions()).toEqual(['close'])

    fireEvent.click(screen.getByRole('button'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('says why, when the reason is this device rather than the backend', () => {
    show(<ChatConnectionBanner label="local" state={{ kind: 'unavailable', reason: 'unsupported-platform' }} />)

    expect(screen.getByText(/this device/i)).toBeInTheDocument()
    expect(actions()).toEqual([])
  })
})

describe('a healthy tab', () => {
  it('renders nothing at all', () => {
    const { container } = show(<ChatConnectionBanner label="deploy box" state={{ kind: 'ok' }} />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('the transcript placeholder', () => {
  it('asks for a reconnect rather than showing an empty conversation', () => {
    show(<TranscriptUnavailable />)

    expect(screen.getByText('Reconnect to load this conversation.')).toBeInTheDocument()
  })
})
