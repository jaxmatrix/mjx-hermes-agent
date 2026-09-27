import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RootTooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/themes'

const openStoredSessionInBubble = vi.fn()

vi.mock('@/lib/haptics', () => ({ triggerHaptic: () => undefined }))
vi.mock('@/store/chat-bubbles', () => ({
  openStoredSessionInBubble: (...args: unknown[]) => openStoredSessionInBubble(...args)
}))
vi.mock('@/app/chat/sidebar/sidebar-content', () => ({
  SidebarScrollBody: () => <div>Sessions body</div>
}))
vi.mock('@/app/resume-session-into-main', () => ({
  resumeSessionIntoMain: vi.fn()
}))
vi.mock('@/app/shell/use-mobile-nav-items', () => ({
  useMobileNavItems: () => [{ icon: 'robot', id: 'new', label: 'New', onSelect: () => undefined }]
}))
vi.mock('@/plugins/hermes-bots/roster-pane', () => ({
  BotsPane: () => <div>Bots body</div>
}))
vi.mock('@/store/profile', async importOriginal => {
  const actual = await importOriginal<typeof import('@/store/profile')>()
  const { atom } = await import('nanostores')

  return {
    ...actual,
    $activeGatewayProfile: atom('default'),
    $profileColors: atom({}),
    $profiles: atom([{ is_default: true, name: 'default' }]),
    profileLabel: (p: { name: string }) => p.name,
    selectProfile: vi.fn()
  }
})

const { $openBotChat } = await import('@/plugins/hermes-bots/bot-state')
const { SessionsWindowHost } = await import('./sessions-window-host')

describe('SessionsWindowHost bot open', () => {
  beforeEach(() => {
    openStoredSessionInBubble.mockReset()
    $openBotChat.set(null)
  })

  it('seeds the bubble strip when a bot chat opens, then closes the window', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <I18nProvider>
          <ThemeProvider>
            <RootTooltipProvider>
              <SessionsWindowHost onClose={onClose} />
            </RootTooltipProvider>
          </ThemeProvider>
        </I18nProvider>
      </MemoryRouter>
    )

    await user.click(screen.getByRole('tab', { name: /bots/i }))

    await act(() => {
      $openBotChat.set({
        key: 'local::radar',
        openedRegistryId: 'bot-chat',
        openedSessionId: 'bot-chat-tip'
      })
    })

    expect(openStoredSessionInBubble).toHaveBeenCalledWith('bot-chat-tip')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes without seeding when the open has no openedSessionId', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <I18nProvider>
          <ThemeProvider>
            <RootTooltipProvider>
              <SessionsWindowHost onClose={onClose} />
            </RootTooltipProvider>
          </ThemeProvider>
        </I18nProvider>
      </MemoryRouter>
    )

    await user.click(screen.getByRole('tab', { name: /bots/i }))

    await act(() => {
      $openBotChat.set({ key: 'local::radar', openedRegistryId: '' })
    })

    expect(openStoredSessionInBubble).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
