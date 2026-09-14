/**
 * Cron actions address the job's OWN profile store (MJXHRM-457).
 *
 * Cron jobs live in per-profile stores on disk and every /api/cron route takes
 * an optional `?profile=` that decides which store it opens. Only the LIST ever
 * sent one, so browsing another profile — or the aggregated 'all' view, whose
 * whole purpose is showing other profiles' jobs — and then pausing, triggering,
 * editing or deleting a row addressed the ACTIVE profile's store instead, where
 * that job id does not exist.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

const hermes = vi.hoisted(() => ({
  createCronJob: vi.fn(async () => ({ enabled: true, id: 'new' })),
  deleteCronJob: vi.fn(async () => ({ ok: true })),
  getAutomationBlueprints: vi.fn(async () => []),
  getCronDeliveryTargets: vi.fn(async () => []),
  getCronJobRuns: vi.fn(async () => []),
  getCronJobs: vi.fn(),
  instantiateAutomationBlueprint: vi.fn(),
  pauseCronJob: vi.fn(async () => ({ enabled: false, id: 'j1' })),
  resumeCronJob: vi.fn(async () => ({ enabled: true, id: 'j1' })),
  setApiRequestProfile: vi.fn(),
  triggerCronJob: vi.fn(async () => ({ enabled: true, id: 'j1' })),
  updateCronJob: vi.fn(async () => ({ enabled: true, id: 'j1' }))
}))

vi.mock('@/hermes', () => hermes)

import { $cronJobs } from '@/store/cron'

import { CronView } from './index'

/** A job the ACTIVE profile does not own — the case the bug was invisible in. */
const foreignJob: CronJob = {
  enabled: true,
  id: 'j1',
  name: 'Work digest',
  profile: 'work',
  prompt: 'go',
  schedule: { expr: '0 9 * * *' }
}

function renderCron(job: CronJob) {
  hermes.getCronJobs.mockImplementation(async () => [job])

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/cron']}>
        <CronView onClose={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** Click a detail-pane action by its accessible name. */
async function detailAction(name: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name }))
}

beforeEach(() => {
  $cronJobs.set([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $cronJobs.set([])
})

describe('cron actions carry the job’s profile', () => {
  it('triggers against the store the job lives in', async () => {
    renderCron(foreignJob)

    await detailAction(/Trigger now/i)

    // Not `('j1')` — an id alone resolves against the ACTIVE profile.
    await waitFor(() => expect(hermes.triggerCronJob).toHaveBeenCalledWith('j1', 'work'))
  })

  it('pauses against the store the job lives in', async () => {
    renderCron(foreignJob)

    await detailAction(/^Pause$/)

    await waitFor(() => expect(hermes.pauseCronJob).toHaveBeenCalledWith('j1', 'work'))
  })

  it('reads the run history out of the store the job lives in', async () => {
    renderCron(foreignJob)

    await waitFor(() => expect(hermes.getCronJobRuns).toHaveBeenCalledWith('j1', undefined, 'work'))
  })

  // A fixture that DISAGREES: an unannotated record (an older gateway) must
  // still send NO profile rather than a made-up one, which would retarget the
  // request at a store the job is not in.
  it('sends no profile for a job the gateway did not annotate', async () => {
    renderCron({ enabled: true, id: 'j1', name: 'Local digest', prompt: 'go' })

    await detailAction(/Trigger now/i)

    await waitFor(() => expect(hermes.triggerCronJob).toHaveBeenCalledWith('j1', undefined))
  })
})
