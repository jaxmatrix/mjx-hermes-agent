import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: () => undefined }))
vi.mock('@/store/session-lookup', () => ({
  chatTabTitle: ({ stored }: { stored?: { id?: string } | null }) => stored?.id ?? 'New session',
  useSessionRowLookup: () => (id: null | string | undefined) => (id ? { id } : undefined)
}))
vi.mock('../session-status-dot', () => ({
  SessionStatusDot: () => null
}))

const { $chatBubbles } = await import('@/store/chat-bubbles')
const { $activeStoredSessionId } = await import('@/store/session-lifecycle')
const { $botMeta } = await import('@/plugins/hermes-bots/data')
const { $botChatScopes, $botChatSessionIds, setSessionTileWorkspaceScope } = await import(
  '@/store/session-states'
)
const { BubbleRow } = await import('./bubble-row')

describe('BubbleRow bot icon', () => {
  beforeEach(() => {
    $chatBubbles.set([
      {
        connectionId: 'local',
        profile: 'default',
        runtimeId: undefined,
        storedSessionId: 'regular-1',
        tabKey: 'local::default::regular-1'
      },
      {
        connectionId: 'local',
        profile: 'radar',
        runtimeId: undefined,
        storedSessionId: 'bot-1',
        tabKey: 'local::radar::bot-1'
      }
    ])
    $activeStoredSessionId.set('bot-1')
    $botChatSessionIds.set(new Set())
    $botChatScopes.set({})
    $botMeta.set({
      'local::radar': { shape: 'hexagon', color: '#22c55e' }
    })
  })

  it('renders the bot profile face for a bot-scoped bubble and MessageCircle otherwise', () => {
    setSessionTileWorkspaceScope('bot-1', {
      workspaceMode: 'bots',
      workspaceOwnerKey: 'bot:local::radar',
      workspaceTabTitle: 'Bot Chat'
    })

    render(
      <I18nProvider>
        <BubbleRow />
      </I18nProvider>
    )

    const botButton = screen.getByRole('button', { name: 'bot-1' })
    const regularButton = screen.getByRole('button', { name: 'regular-1' })

    expect(botButton.querySelector('[data-hb-math]')).toBeTruthy()
    expect(botButton.querySelector('.codicon-robot')).toBeNull()
    expect(regularButton.querySelector('[data-hb-math]')).toBeNull()
    expect(regularButton.querySelector('.tabler-icon-message-circle')).toBeTruthy()
  })
})
