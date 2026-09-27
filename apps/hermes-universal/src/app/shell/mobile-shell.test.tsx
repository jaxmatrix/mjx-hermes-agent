import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ContribWiringContext } from '@/app/contrib/context'
import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/themes'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: () => undefined }))
vi.mock('./hooks/use-restore-last-session', () => ({ useRestoreLastSession: () => undefined }))
vi.mock('./sessions-window-host', () => ({ SessionsWindowHost: () => null }))
vi.mock('./workspace-window-host', () => ({ WorkspaceWindowHost: () => null }))
vi.mock('./mobile-top-bar', () => ({
  MobileTopBar: () => <div data-testid="mobile-top-bar" />
}))
vi.mock('@/hooks/use-keyboard-inset', () => ({ useKeyboardInset: () => undefined }))
vi.mock('./sidebar', () => ({
  useSidebar: () => ({
    openMobile: false,
    openMobileRight: false,
    setOpenMobile: () => undefined,
    setOpenMobileRight: () => undefined
  })
}))

import { MobileShell } from './mobile-shell'

describe('MobileShell', () => {
  it('renders desktop chatRoutes instead of ChatScreen WorkspaceRoutes', () => {
    const { container } = render(
      <I18nProvider>
        <ThemeProvider>
          <ContribWiringContext.Provider
            value={{
              chatRoutes: <div data-testid="desktop-chat-routes">ChatView</div>,
              sidebar: null,
              statusbar: null,
              terminal: null
            }}
          >
            <MobileShell />
          </ContribWiringContext.Provider>
        </ThemeProvider>
      </I18nProvider>
    )

    expect(screen.getByTestId('desktop-chat-routes')).toBeTruthy()
    expect(screen.getByTestId('mobile-top-bar')).toBeTruthy()

    const shell = container.querySelector('[data-slot="mobile-shell"]') as HTMLElement
    expect(shell.style.paddingLeft).toBe('var(--safe-area-inset-left, 0px)')
    expect(shell.style.paddingRight).toBe('var(--safe-area-inset-right, 0px)')
  })
})
