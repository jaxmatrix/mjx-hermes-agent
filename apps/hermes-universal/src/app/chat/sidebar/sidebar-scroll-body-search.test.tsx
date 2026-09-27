import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { RootTooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/themes'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: () => undefined }))
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listSidebarSessions: vi.fn().mockResolvedValue({
    recents: { sessions: [], profiles_truncated: {} },
    cron: { sessions: [] },
    messaging: { sessions: [] }
  }),
  listAllProfileSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  searchSessions: vi.fn().mockResolvedValue([])
}))
vi.mock('@/app/cron/cron-actions', () => ({
  refreshCronJobs: vi.fn(async () => ({ jobs: [], refreshError: null, stale: false })),
  triggerAndRefreshCronJobs: vi.fn()
}))

import { SidebarScrollBody } from './sidebar-content'

describe('SidebarScrollBody search pin', () => {
  it('keeps bottom search outside the sessions scroll port', () => {
    const { container } = render(
      <MemoryRouter>
        <I18nProvider>
          <ThemeProvider>
            <RootTooltipProvider>
              <div style={{ height: 480, width: 360 }}>
                <SidebarScrollBody searchPlacement="bottom" />
              </div>
            </RootTooltipProvider>
          </ThemeProvider>
        </I18nProvider>
      </MemoryRouter>
    )

    const search = container.querySelector('[data-slot="sessions-search"]')
    const port = container.querySelector('[data-slot="sessions-scroll-port"]')

    expect(search).toBeTruthy()
    expect(port).toBeTruthy()
    expect(port!.contains(search!)).toBe(false)
    expect(screen.getByLabelText(/search/i)).toBeTruthy()
  })
})
