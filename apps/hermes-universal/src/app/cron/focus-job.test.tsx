/**
 * The other half of "Manage opens THIS job" (MJXHRM-377): the cron surface
 * reading the job out of `$cronFocusJobId`.
 *
 * The focus effect clears the atom as soon as it runs — seed `$cronJobs` before
 * focusing so the match lands against a populated list (an empty pre-fetch
 * atom would throw the focus away).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

const jobs: CronJob[] = [
  { enabled: true, id: 'alpha-job', name: 'Alpha backup' },
  { enabled: true, id: 'zulu-job', name: 'Zulu digest' }
]

const hermes = vi.hoisted(() => ({
  getApiRequestConnection: () => null,
  getApiRequestProfile: () => 'default',
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  getAutomationBlueprints: vi.fn(async () => []),
  getCronDeliveryTargets: vi.fn(async () => []),
  getCronJobRuns: vi.fn(async () => []),
  getCronJobs: vi.fn(),
  instantiateAutomationBlueprint: vi.fn(),
  pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(),
  // Reached at import time through store/profile → store/profiles.
  setApiRequestProfile: vi.fn(),
  triggerCronJob: vi.fn(),
  updateCronJob: vi.fn()
}))

vi.mock('@/hermes', () => hermes)

import { $cronFocusJobId, $cronJobs, setCronFocusJobId } from '@/store/cron'

import { CronView } from './index'

function renderCron() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/cron']}>
        <CronView onClose={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** The detail pane's heading — the job the surface actually opened on. */
const openedJob = () => screen.getByRole('heading', { level: 3 }).textContent

beforeEach(() => {
  $cronJobs.set([])
  setCronFocusJobId(null)
  // Resolve on a later tick, like a real fetch: the view renders empty first.
  hermes.getCronJobs.mockImplementation(async () => jobs)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $cronJobs.set([])
  setCronFocusJobId(null)
})

describe('cron surface focus', () => {
  it('opens the job named in the focus atom, not the first one', async () => {
    // Seed the list first: the focus effect clears as soon as it runs, and an
    // empty atom (pre-fetch) would throw the focus away before the match can
    // land — desktop dropped the `loading` gate when focus moved off the URL.
    $cronJobs.set(jobs)
    setCronFocusJobId('zulu-job')
    renderCron()

    // 'Alpha backup' is what this surface selects on its own (it sorts first),
    // so landing on 'Zulu digest' can only come from the focus atom.
    await waitFor(() => expect(openedJob()).toBe('Zulu digest'))
    expect($cronFocusJobId.get()).toBeNull()
  })

  it('accepts a job NAME as well as an id', async () => {
    $cronJobs.set(jobs)
    setCronFocusJobId('Zulu digest')
    renderCron()

    await waitFor(() => expect(openedJob()).toBe('Zulu digest'))
  })

  it('falls back to its own selection when nothing is focused', async () => {
    renderCron()

    await waitFor(() => expect(openedJob()).toBe('Alpha backup'))
  })

  it('falls back when the focus names a job that is gone', async () => {
    setCronFocusJobId('deleted-job')
    renderCron()

    await waitFor(() => expect(openedJob()).toBe('Alpha backup'))
  })
})
