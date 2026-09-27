import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MessagingPlatformSection } from './messaging-platform-section'

vi.mock('./sessions-section', () => ({
  SidebarSessionsSection: (props: {
    sessions: { id: string }[]
    onContentScroll?: (e: { currentTarget: HTMLElement }) => void
    footer: unknown
    label: string
  }) => (
    <div data-testid="msg-section">
      <div data-testid="label">{props.label}</div>
      <div
        data-testid="msg-scroll"
        onScroll={event => props.onContentScroll?.(event as unknown as { currentTarget: HTMLElement })}
      >
        {props.sessions.map(s => (
          <div key={s.id}>{s.id}</div>
        ))}
      </div>
      {props.footer}
    </div>
  )
}))

function session(id: string) {
  return { id, title: id } as never
}

describe('MessagingPlatformSection', () => {
  it('reveals more rows near the bottom and asks for API deepen when exhausted', async () => {
    const onRevealExhausted = vi.fn()
    const sessions = Array.from({ length: 12 }, (_, i) => session(`s${i}`))

    render(
      <MessagingPlatformSection
        contentClassName=""
        group={{ hasMore: true, label: 'Telegram', sessions, sourceId: 'telegram' }}
        onRevealExhausted={onRevealExhausted}
        onToggle={() => undefined}
        open
        rowHandlers={{}}
      />
    )

    expect(screen.getByText('s0')).toBeTruthy()
    expect(screen.queryByText('s10')).toBeNull()
    expect(screen.queryByText(/load more/i)).toBeNull()

    const scroll = screen.getByTestId('msg-scroll')
    Object.defineProperty(scroll, 'clientHeight', { value: 100 })
    Object.defineProperty(scroll, 'scrollHeight', { value: 500 })
    Object.defineProperty(scroll, 'scrollTop', { value: 400, writable: true })
    fireEvent.scroll(scroll)

    // INITIAL 3 + REVEAL 10 = 13 ≥ 12 with hasMore → deepen
    expect(screen.getByText('s10')).toBeTruthy()
    expect(onRevealExhausted).toHaveBeenCalled()
  })
})
