/**
 * MJXHRM-452 — the cron panel's empty states stop suggesting a broader search
 * when no search is running.
 *
 * ZERO jobs short-circuits to a whole-panel empty, so the defect lives in the
 * state that is easy to miss: jobs EXIST but none are visible, because "Hide
 * paused" filtered them all out. Both empty slots — the list footer and the
 * detail pane — rendered search copy unconditionally, so a user who had never
 * typed anything was told to "Try a broader search query".
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

const hermes = vi.hoisted(() => ({
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  getAutomationBlueprints: vi.fn(async () => []),
  getCronDeliveryTargets: vi.fn(async () => []),
  getCronJobRuns: vi.fn(async () => []),
  getCronJobs: vi.fn(async () => [] as CronJob[]),
  instantiateAutomationBlueprint: vi.fn(),
  pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(),
  setApiRequestProfile: vi.fn(),
  triggerCronJob: vi.fn(),
  updateCronJob: vi.fn()
}))

vi.mock('@/hermes', () => hermes)

import { $cronJobs } from '@/store/cron'

import { $hideDisabledCronJobs, CronView } from './index'

const renderCron = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/cron']}>
        <CronView onClose={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>
  )

beforeEach(() => {
  $cronJobs.set([])
  $hideDisabledCronJobs.set(false)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $cronJobs.set([])
})

const pausedJob = (id: string): CronJob => ({ id, name: `job ${id}`, state: 'paused' }) as CronJob

describe('cron empty states with no search running', () => {
  it('does not blame the search when "Hide paused" is what emptied the list', async () => {
    // The fixture DISAGREES with the assertion's premise on purpose: there ARE
    // jobs (so the whole-panel empty never fires) and no query has been typed,
    // yet nothing is visible.
    hermes.getCronJobs.mockImplementation(async () => [pausedJob('a'), pausedJob('b')])
    $hideDisabledCronJobs.set(true)
    renderCron()

    await waitFor(() => expect(screen.getByText('No scheduled jobs yet')).toBeInTheDocument())

    expect(screen.queryByText('No matches')).toBeNull()
    expect(screen.queryByText('Try a broader search query.')).toBeNull()
  })

  it('still uses the search copy when a query IS what emptied the list', async () => {
    // The complement — without it, "never show search copy" would pass.
    hermes.getCronJobs.mockImplementation(async () => [pausedJob('a')])
    $hideDisabledCronJobs.set(false)
    renderCron()

    await waitFor(() => expect(screen.getAllByText('job a').length).toBeGreaterThan(0))

    // By role, not placeholder: SearchField cycles the `searchHints` through
    // the placeholder attribute, so the configured string is never on the DOM.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zzz-no-such-job' } })

    await waitFor(() => expect(screen.getByText('No matches')).toBeInTheDocument())
    expect(screen.getByText('Try a broader search query.')).toBeInTheDocument()
  })
})
