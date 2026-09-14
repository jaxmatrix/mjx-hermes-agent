import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionRoute } from '@/app/routes'
import { I18nProvider } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { queryClient } from '@/lib/query-client'
import { __resetTranscriptTailCache, saveTranscriptTail } from '@/lib/transcript-tail-cache'
import { $connectionError } from '@/store/connection'
import { $restorePaintEnabled } from '@/store/restore-paint'
import { $activeStoredSessionId, forgetLastSessionMarkers } from '@/store/session'
import { __resetTranscriptPaint } from '@/store/transcript-paint'
import * as windows from '@/store/windows'

import { GatewayConnectingScreen } from './gateway-connecting-screen'

const renderScreen = (route = '/') =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <GatewayConnectingScreen />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>
  )

const row = (id: string, body: string): ChatMessage => ({ id, parts: [{ text: body, type: 'text' }], role: 'user' })

/** Remember a chat the way the app does — the marker is written by the
 *  `$activeStoredSessionId` subscriber on every switch. */
const rememberSession = (storedId: string) => $activeStoredSessionId.set(storedId)

const backdrop = () => document.querySelector('[data-slot="cached-transcript-preview"]')

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  __resetTranscriptTailCache()
  __resetTranscriptPaint()
  forgetLastSessionMarkers()
  $activeStoredSessionId.set(null)
  $restorePaintEnabled.set(true)
})

afterEach(() => $connectionError.set(null))

describe('GatewayConnectingScreen recovery', () => {
  it('offers the escape hatch without showing the configurator while dialling', () => {
    renderScreen()
    expect(screen.getByRole('button', { name: 'Use a different gateway' })).toBeInTheDocument()
    expect(screen.queryByText('Connection mode')).not.toBeInTheDocument()
  })

  // A failed dial is where re-homing matters: the connect surface comes to the user
  // instead of dropping them back to the picker.
  it('reveals the embedded configurator once the dial errors', () => {
    $connectionError.set('connection refused')
    renderScreen()
    expect(screen.getByText('connection refused')).toBeInTheDocument()
    expect(screen.getByText('Connection mode')).toBeInTheDocument()
    // Giving up entirely stays reachable.
    expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument()
  })
})

// The ticket's headline: the last screen is on the glass BEFORE the socket is
// up — this surface renders while `$connectionPhase` is anything but 'ready',
// and it reads the cache synchronously in its first render.
describe('GatewayConnectingScreen boot paint', () => {
  it('paints the remembered conversation behind the connecting card', () => {
    rememberSession('stored-1')
    saveTranscriptTail('stored-1', [row('m1', 'the last thing you read')])

    renderScreen()

    expect(screen.getByText('the last thing you read')).toBeInTheDocument()
    // The card keeps the foreground, with its escape hatch intact.
    expect(screen.getByRole('button', { name: 'Use a different gateway' })).toBeInTheDocument()
  })

  // A route that NAMES a session outranks the memory; a route that names some
  // other screen must not drag the user onto a conversation at all
  // (`resolveSessionLanding`).
  it('follows the route when it names a session, and paints nothing on another screen', () => {
    rememberSession('stored-1')
    saveTranscriptTail('stored-1', [row('m1', 'remembered')])
    saveTranscriptTail('stored-2', [row('m2', 'deep linked')])

    renderScreen(sessionRoute('stored-2'))
    expect(screen.getByText('deep linked')).toBeInTheDocument()

    __resetTranscriptPaint()
    renderScreen('/settings')
    expect(screen.queryByText('remembered')).not.toBeInTheDocument()
  })

  it('paints nothing with no remembered chat, with no cached tail, or with the pref off', () => {
    renderScreen()
    expect(backdrop()).toBeNull()

    rememberSession('stored-nothing-cached')
    renderScreen()
    expect(backdrop()).toBeNull()

    rememberSession('stored-1')
    saveTranscriptTail('stored-1', [row('m1', 'cached')])
    $restorePaintEnabled.set(false)
    renderScreen()
    expect(backdrop()).toBeNull()
  })

  // "Which conversation you were last in" is single-writer app state, so a
  // detached tile window or an Android ScreenActivity must not paint one.
  it('paints nothing in a window that does not own the persisted app state', () => {
    rememberSession('stored-1')
    saveTranscriptTail('stored-1', [row('m1', 'cached')])
    vi.spyOn(windows, 'ownsPersistedAppState').mockReturnValue(false)

    renderScreen()

    expect(backdrop()).toBeNull()
  })

  // This is what makes it safe to show a session with no runtime binding: there
  // is nothing to interact with, so nothing here can create or submit to a chat.
  it('is inert — aria-hidden, no pointer events, no focusable node', () => {
    rememberSession('stored-1')
    saveTranscriptTail('stored-1', [row('m1', 'cached')])

    renderScreen()

    const preview = backdrop() as HTMLElement

    expect(preview).not.toBeNull()
    expect(preview.getAttribute('aria-hidden')).toBe('true')
    expect(preview.className).toContain('pointer-events-none')
    expect(preview.querySelectorAll('a, button, input, textarea, [tabindex]')).toHaveLength(0)
  })
})
