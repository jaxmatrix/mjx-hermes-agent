import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

const job = (over: Partial<CronJob>): CronJob => ({ id: 'x', enabled: true, ...over })

vi.mock('@/hermes', () => ({
  getCronJobs: vi.fn(async () => [job({ id: 'a', name: 'A', enabled: true }), job({ id: 'b', name: 'B', enabled: false })]),
  pauseCronJob: vi.fn(async (id: string) => job({ id, enabled: false })),
  resumeCronJob: vi.fn(async (id: string) => job({ id, enabled: true })),
  triggerCronJob: vi.fn(async (id: string) => job({ id })),
  deleteCronJob: vi.fn(async () => ({ ok: true })),
  createCronJob: vi.fn(async () => job({ id: 'new', name: 'New' })),
  updateCronJob: vi.fn(async (id: string) => job({ id, name: 'Updated' }))
}))

import { pauseCronJob } from '@/hermes'

import { $cronJobs, refreshCronJobs, removeCron, setCronEnabled } from './cron'

const pause = vi.mocked(pauseCronJob)

describe('cron store', () => {
  beforeEach(() => {
    pause.mockClear()
    $cronJobs.set([])
  })
  afterEach(() => $cronJobs.set([]))

  it('loads the job list', async () => {
    await refreshCronJobs()
    expect($cronJobs.get().map(j => j.id)).toEqual(['a', 'b'])
  })

  it('disables a job optimistically and via pauseCronJob', async () => {
    await refreshCronJobs()
    await setCronEnabled('a', false)
    expect(pause).toHaveBeenCalledWith('a')
    expect($cronJobs.get().find(j => j.id === 'a')?.enabled).toBe(false)
  })

  it('removes a job optimistically', async () => {
    await refreshCronJobs()
    await removeCron('a')
    expect($cronJobs.get().map(j => j.id)).toEqual(['b'])
  })
})
