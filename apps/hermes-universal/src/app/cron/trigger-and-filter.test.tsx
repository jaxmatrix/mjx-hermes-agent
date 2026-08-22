/**
 * Trigger feedback and the include_disabled filter, mounted (MJXHRM-457).
 *
 * Trigger runs through the vendored `cron-trigger-controller` — the same guard
 * the web dashboard and desktop use — so a trigger announces before the request
 * leaves and cannot be fired twice while the first is in the air. The filter is
 * client-side: the REST listing always returns disabled jobs, unlike the
 * `cron.manage` RPC, which defaults include_disabled false.
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
  getCronJobs: vi.fn(),
  instantiateAutomationBlueprint: vi.fn(),
  pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(),
  setApiRequestProfile: vi.fn(),
  triggerCronJob: vi.fn(),
  updateCronJob: vi.fn()
}))

vi.mock('@/hermes', () => hermes)

const notifications = vi.hoisted(() => ({ notify: vi.fn(), notifyError: vi.fn() }))

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...notifications
}))

import { $cronJobs } from '@/store/cron'

import { CronView } from './index'

function renderCron(jobs: CronJob[]) {
  hermes.getCronJobs.mockImplementation(async () => jobs)

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/cron']}>
        <CronView onClose={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const job = (over: Partial<CronJob>): CronJob => ({ enabled: true, id: 'j1', prompt: 'go', ...over })

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(res => {
    resolve = res
  })

  return { promise, resolve }
}

beforeEach(() => {
  $cronJobs.set([])
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $cronJobs.set([])
})

describe('trigger feedback', () => {
  it('announces before the request comes back, not after', async () => {
    const request = deferred<CronJob>()

    hermes.triggerCronJob.mockImplementation(() => request.promise)
    renderCron([job({ name: 'Digest' })])

    fireEvent.click(await screen.findByRole('button', { name: /Trigger now/i }))

    // The run has NOT resolved — a surface that only spoke on success left a
    // long trigger looking like a click that did nothing.
    await waitFor(() => expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info' })))
    expect(notifications.notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))

    request.resolve(job({ name: 'Digest' }))
    await waitFor(() => expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' })))
  })

  it('does not fire a second run while the first is in the air', async () => {
    const request = deferred<CronJob>()

    hermes.triggerCronJob.mockImplementation(() => request.promise)
    renderCron([job({ name: 'Digest' })])

    const button = await screen.findByRole('button', { name: /Trigger now/i })

    fireEvent.click(button)
    // The controller keys per job, so this second click is swallowed rather
    // than starting a duplicate run behind the first.
    fireEvent.click(button)

    await waitFor(() => expect(hermes.triggerCronJob).toHaveBeenCalledTimes(1))

    request.resolve(job({ name: 'Digest' }))
  })
})

describe('include_disabled filter', () => {
  const jobs = [job({ id: 'live', name: 'Live digest' }), job({ enabled: false, id: 'off', name: 'Paused digest' })]

  // Default OFF: a management surface that hides paused jobs reads as if
  // pausing deleted them.
  it('shows paused jobs by default', async () => {
    renderCron(jobs)

    expect(await screen.findAllByText('Paused digest')).not.toHaveLength(0)
  })

  it('hides them once the filter is on', async () => {
    renderCron(jobs)

    fireEvent.click(await screen.findByRole('button', { name: 'Hide paused' }))

    await waitFor(() => expect(screen.queryByText('Paused digest')).toBeNull())
    // ...and only those: the enabled job must survive the filter, or this is
    // an empty list rather than a filter.
    expect(screen.getAllByText('Live digest').length).toBeGreaterThan(0)
  })
})
