import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as PaneTreeStore from '@/components/pane-shell/tree/store'

const openInAppBrowser = vi.fn(() => Promise.resolve(true))
const closeInAppBrowser = vi.fn()
const previewFile = vi.fn()
const treePanesWithPrefix = vi.fn(() => [] as string[])

// PARTIAL: `session-states.ts` subscribes to `$layoutTree` at module scope, so
// a wholesale mock leaves the real module importing an undefined atom.
vi.mock('@/components/pane-shell/tree/store', async importOriginal => ({
  ...(await importOriginal<typeof PaneTreeStore>()),
  treePanesWithPrefix
}))
vi.mock('@/store/preview-open', () => ({ previewFile }))

vi.mock('@/store/browser', async () => {
  const { atom, computed } = await import('@/store/atom')
  const $browserState = atom({ url: '' })

  return {
    $browserState,
    $browserSupported: computed($browserState, () => true),
    closeInAppBrowser,
    ensureBrowserCapabilities: () => Promise.resolve({ host: 'child-webview' }),
    openInAppBrowser
  }
})

const { $browserState } = await import('@/store/browser')
const { $chatBubbles } = await import('@/store/chat-bubbles')
const { $activeStoredSessionId } = await import('@/store/session')
const { handleGatewayEventForTest, sessionIsOnScreen } = await import('./browser-bridge')

beforeEach(() => {
  vi.clearAllMocks()
  treePanesWithPrefix.mockReturnValue([])
  $activeStoredSessionId.set(null)
  $chatBubbles.set([])
  ;($browserState as unknown as { set: (value: unknown) => void }).set({ url: '' })
})

describe('sessionIsOnScreen', () => {
  it('is false for a session visible nowhere', () => {
    // Making it return true unconditionally turns this red — and that is the
    // whole "offer, don't hijack" rule.
    expect(sessionIsOnScreen('sess-elsewhere')).toBe(false)
    expect(sessionIsOnScreen(null)).toBe(false)
    expect(sessionIsOnScreen(undefined)).toBe(false)
  })

  it('is true for the active session', () => {
    $activeStoredSessionId.set('sess-a')

    expect(sessionIsOnScreen('sess-a')).toBe(true)
  })

  it('is true for a session the user has TILED, even in the background', () => {
    treePanesWithPrefix.mockReturnValue(['session-tile:sess-b'])

    expect(sessionIsOnScreen('sess-b')).toBe(true)
  })

  it('is true for a phone chat bubble', () => {
    $chatBubbles.set([{ storedSessionId: 'sess-c' }])

    expect(sessionIsOnScreen('sess-c')).toBe(true)
  })
})

describe('preview.open / preview.close', () => {
  it('is DROPPED for a session on screen nowhere', () => {
    handleGatewayEventForTest({
      payload: { url: 'https://example.com' },
      session_id: 'sess-elsewhere',
      type: 'preview.open'
    })

    expect(openInAppBrowser).not.toHaveBeenCalled()
  })

  it('opens for a session on screen', () => {
    $activeStoredSessionId.set('sess-a')

    handleGatewayEventForTest({
      payload: { label: 'Docs', url: 'https://example.com' },
      session_id: 'sess-a',
      type: 'preview.open'
    })

    expect(openInAppBrowser).toHaveBeenCalledWith('https://example.com', 'Docs')
  })

  it('routes a PATH to the file tab, not the browser', () => {
    // `open_preview` accepts "a web URL, a localhost URL, or a file path", and
    // the gateway passes paths through untouched.
    $activeStoredSessionId.set('sess-a')

    handleGatewayEventForTest({
      payload: { url: '/repo/src/main.tsx' },
      session_id: 'sess-a',
      type: 'preview.open'
    })

    expect(previewFile).toHaveBeenCalledWith('/repo/src/main.tsx')
    expect(openInAppBrowser).not.toHaveBeenCalled()
  })

  it('closes on an empty preview.close', () => {
    handleGatewayEventForTest({ payload: {}, type: 'preview.close' })

    expect(closeInAppBrowser).toHaveBeenCalled()
  })

  it('an UNMATCHED close is a no-op — a missed match must not wipe the rail', () => {
    ;($browserState as unknown as { set: (value: unknown) => void }).set({ url: 'https://other.example/' })

    handleGatewayEventForTest({ payload: { url: 'https://example.com' }, type: 'preview.close' })

    expect(closeInAppBrowser).not.toHaveBeenCalled()
  })

  it('closes when the address matches after normalisation', () => {
    ;($browserState as unknown as { set: (value: unknown) => void }).set({ url: 'https://example.com/' })

    handleGatewayEventForTest({ payload: { url: 'example.com' }, type: 'preview.close' })

    expect(closeInAppBrowser).toHaveBeenCalled()
  })
})
