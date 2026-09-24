/**
 * MJXHRM-308 (desktop-shaped) — a tile's composer scope must follow the
 * runtime id the tile is bound to.
 *
 * Desktop recovery rebinds via `patchSessionTile({ runtimeId })`
 * (`bindRecoveredRuntime` in session-tile-actions). After that rebind, a
 * clarify parked on the new runtime must light `$awaitingInput` so Esc leaves
 * the question answerable instead of interrupting the turn.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useComposerScope } from '@/app/chat/composer/scope'
import { useSessionView } from '@/app/chat/session-view'
import { createClientSessionState } from '@/lib/chat-runtime'
import { useStore } from '@/store/atom'

import type * as ChatIndex from '.'

vi.mock('@/store/gateway-client', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: vi.fn().mockResolvedValue({})
  }
})

// TileChat mounts ChatView under SessionView + ComposerScope; stand in with a
// probe so the assertion is about the scope, not the full chat shell.
vi.mock('.', async importOriginal => {
  const actual = await importOriginal<typeof ChatIndex>()

  return {
    ...actual,
    ChatView: () => {
      const scope = useComposerScope()
      const view = useSessionView()

      return (
        <span data-testid="awaiting">
          {String(useStore(scope.$awaitingInput))}
          <b data-testid="key">{String(useStore(view.$runtimeId))}</b>
        </span>
      )
    }
  }
})

const { $gatewayState } = await import('@/store/session')
const { $sessionStates, $sessionTiles, patchSessionTile, publishSessionState } = await import('@/store/session-states')
const { clearAllPrompts } = await import('@/store/prompts')
const { setSessionClarify } = await import('@/store/prompt-session-bridge')
const { SessionTilePane } = await import('./session-tile')

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

beforeEach(() => {
  $sessionStates.set({})
  $sessionTiles.set([])
  $gatewayState.set('open')
  clearAllPrompts()
})

afterEach(() => {
  cleanup()
  clearAllPrompts()
})

describe('SessionTilePane composer scope', () => {
  it('sees a clarify raised after a recovery rebound the tile runtime', async () => {
    publishSessionState('runtime-1', createClientSessionState('stored-1'))
    $sessionTiles.set([{ connectionId: 'local', profile: 'default', storedSessionId: 'stored-1' }])
    patchSessionTile('stored-1', { runtimeId: 'runtime-1' })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SessionTilePane storedSessionId="stored-1" />
        </MemoryRouter>
      </QueryClientProvider>
    )

    expect(screen.getByTestId('awaiting').textContent).toBe('falseruntime-1')

    // Desktop recovery rebinds the tile's cached runtimeId (session-tile-actions
    // `bindRecoveredRuntime`) — the pane then rebuilds composer scope for the
    // live key.
    act(() => {
      publishSessionState('runtime-2', {
        ...createClientSessionState('stored-1'),
        runtimeSessionId: 'runtime-2'
      })
      patchSessionTile('stored-1', { runtimeId: 'runtime-2' })
    })

    expect($sessionTiles.get()[0].runtimeId).toBe('runtime-2')
    expect(screen.getByTestId('key').textContent).toBe('runtime-2')

    act(() => {
      setSessionClarify('runtime-2', {
        requestId: 'c1',
        question: 'which one?',
        choices: null,
        multiSelect: false
      })
    })

    expect(await screen.findByText('true')).toBeTruthy()
  })
})
