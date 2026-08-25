/**
 * Continuity and the missed-fire stamp, mounted (MJXHRM-457).
 *
 * The pure rules live in `cron-job-model.test.ts`; what this file pins is the
 * WIRING — that the detail pane renders a fire the scheduler never started, and
 * that the editor round-trips the continuity toggle without eating the external
 * `context_from` refs it has no control for.
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

import { $cronJobs } from '@/store/cron'

import { CronView } from './index'

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

/** Open the row's kebab and pick Edit — the only route into the editor. */
async function openEditor(title: string) {
  const row = (await screen.findAllByText(title))
    .map(node => node.closest('[data-panel-row]'))
    .find(Boolean) as HTMLElement

  const kebab = Array.from(row.querySelectorAll('button')).find(
    button => button.getAttribute('aria-label') === 'Cron job actions'
  )!

  fireEvent.pointerDown(kebab, { button: 0, pointerType: 'mouse' })
  fireEvent.click(await screen.findByText('Edit cron'))

  return screen.findByRole('switch')
}

beforeEach(() => {
  $cronJobs.set([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $cronJobs.set([])
})

describe('missed scheduled fire', () => {
  // The shape this exists for: no execution row is ever created, so last_status
  // and last_error stay clean and the job reads as perfectly healthy while it
  // silently never runs.
  it('surfaces a fire the scheduler never started', async () => {
    renderCron({
      enabled: true,
      id: 'missed',
      last_fire_error: { at: '2026-08-20T09:00:00Z', detail: 'gateway unreachable' },
      name: 'Morning brief'
    })

    expect(await screen.findByText(/gateway unreachable/)).toBeTruthy()
    expect(screen.getByText(/Missed scheduled fire/)).toBeTruthy()
  })

  it('says nothing about a job the scheduler has always reached', async () => {
    renderCron({ enabled: true, id: 'fine', last_fire_error: null, name: 'Morning brief' })

    await screen.findAllByText('Morning brief')
    expect(screen.queryByText(/Missed scheduled fire/)).toBeNull()
  })

  // A stamp the backend left without a detail says nothing actionable; rendering
  // it would put an empty red box on a healthy job.
  it('says nothing when the stamp carries no detail', async () => {
    renderCron({ enabled: true, id: 'blank', last_fire_error: { at: '2026-08-20T09:00:00Z' }, name: 'Morning brief' })

    await screen.findAllByText('Morning brief')
    expect(screen.queryByText(/Missed scheduled fire/)).toBeNull()
  })
})

describe('continuity toggle', () => {
  // REST (/api/cron/jobs) returns the RAW record, so the reserved ref is still
  // inside context_from. Seeding the switch off here would write that "off" back
  // on the next save and silently unlink the job from its own history.
  it('reads as on for a job carrying the reserved ref', async () => {
    renderCron({ context_from: ['self'], enabled: true, id: 'j1', name: 'Digest' })

    expect(await openEditor('Digest')).toBeChecked()
  })

  // The RPC serializer strips `self` and sets an explicit flag instead.
  it('reads as on for a job carrying the explicit flag', async () => {
    renderCron({ continuity: true, enabled: true, id: 'j1', name: 'Digest' })

    expect(await openEditor('Digest')).toBeChecked()
  })

  // A fixture that DISAGREES: refs are present, none of them self-referential.
  it('reads as off for a job that only feeds on other jobs', async () => {
    renderCron({ context_from: ['upstream-a'], enabled: true, id: 'j1', name: 'Digest' })

    expect(await openEditor('Digest')).not.toBeChecked()
  })

  it('writes the reserved ref, keeping the refs the editor never showed', async () => {
    hermes.updateCronJob.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      enabled: true,
      id: 'j1',
      name: 'Digest',
      ...updates
    }))
    renderCron({
      context_from: ['upstream-a'],
      enabled: true,
      id: 'j1',
      name: 'Digest',
      prompt: 'go',
      schedule: { expr: '0 9 * * *' }
    })

    fireEvent.click(await openEditor('Digest'))
    fireEvent.click(screen.getByText('Save changes'))

    // 'upstream-a' is set from the CLI or the dashboard and this editor has no
    // control for it — writing a bare ['self'] would delete it.
    await waitFor(() =>
      expect(hermes.updateCronJob).toHaveBeenCalledWith(
        'j1',
        expect.objectContaining({ context_from: ['upstream-a', 'self'] }),
        undefined
      )
    )
  })

  // Turning it off must write an EXPLICIT null: an omitted key means "leave the
  // stored list alone", so the toggle would silently spring back.
  it('clears the ref explicitly when switched off', async () => {
    hermes.updateCronJob.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      enabled: true,
      id: 'j1',
      name: 'Digest',
      ...updates
    }))
    renderCron({
      context_from: ['self'],
      enabled: true,
      id: 'j1',
      name: 'Digest',
      prompt: 'go',
      schedule: { expr: '0 9 * * *' }
    })

    fireEvent.click(await openEditor('Digest'))
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() =>
      expect(hermes.updateCronJob).toHaveBeenCalledWith(
        'j1',
        expect.objectContaining({ context_from: null }),
        undefined
      )
    )
  })
})
