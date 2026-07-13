import {
  createCronJob,
  deleteCronJob,
  getCronJobs,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
  updateCronJob
} from '@/hermes'
import { atom } from '@/store/atom'
import { notifyError } from '@/store/notifications'
import type { CronJob, CronJobCreatePayload, CronJobUpdates } from '@/types/hermes'

// Scheduled-jobs (cron) store — lean, optimistic, mirrors store/session.ts.
export const $cronJobs = atom<CronJob[]>([])
export const $cronLoading = atom(false)
export const $cronLoadError = atom<string | null>(null)

export async function refreshCronJobs(): Promise<void> {
  $cronLoading.set(true)
  $cronLoadError.set(null)
  try {
    $cronJobs.set(await getCronJobs())
  } catch (err) {
    $cronLoadError.set(err instanceof Error ? err.message : 'Failed to load cron jobs')
  } finally {
    $cronLoading.set(false)
  }
}

function replace(job: CronJob) {
  $cronJobs.set($cronJobs.get().map(j => (j.id === job.id ? job : j)))
}

/** Enable/disable a job (resume/pause), optimistic with rollback. */
export async function setCronEnabled(id: string, enabled: boolean): Promise<void> {
  const prev = $cronJobs.get()
  $cronJobs.set(prev.map(j => (j.id === id ? { ...j, enabled } : j)))
  try {
    const updated = enabled ? await resumeCronJob(id) : await pauseCronJob(id)
    replace(updated)
  } catch (err) {
    $cronJobs.set(prev)
    notifyError(err, enabled ? 'Resume failed' : 'Pause failed')
  }
}

export async function triggerCron(id: string): Promise<void> {
  try {
    replace(await triggerCronJob(id))
  } catch (err) {
    notifyError(err, 'Trigger failed')
  }
}

export async function removeCron(id: string): Promise<void> {
  const prev = $cronJobs.get()
  $cronJobs.set(prev.filter(j => j.id !== id))
  try {
    await deleteCronJob(id)
  } catch (err) {
    $cronJobs.set(prev)
    notifyError(err, 'Delete failed')
  }
}

/** Create a new job or update an existing one, then reflect it in the list. */
export async function saveCron(
  jobId: string | null,
  payload: CronJobCreatePayload & CronJobUpdates
): Promise<boolean> {
  try {
    if (jobId) {
      replace(await updateCronJob(jobId, payload))
    } else {
      $cronJobs.set([await createCronJob(payload), ...$cronJobs.get()])
    }
    return true
  } catch (err) {
    notifyError(err, jobId ? 'Update failed' : 'Create failed')
    return false
  }
}
