import type { CronJob } from '@/types/hermes'

// Cron job display state + dot color (adapted from desktop `app/cron/job-state`).
// The backend sets `state` when it has one (running/completed/error/…); otherwise
// the job's enabled flag decides scheduled vs disabled.
export function jobState(job: CronJob): string {
  return job.state || (job.enabled ? 'scheduled' : 'disabled')
}

export const STATE_DOT: Record<string, string> = {
  scheduled: 'bg-(--ui-accent)',
  enabled: 'bg-(--ui-accent)',
  running: 'bg-(--ui-accent)',
  paused: 'bg-amber-500',
  disabled: 'bg-(--ui-text-quaternary)',
  error: 'bg-(--ui-danger)',
  completed: 'bg-(--ui-good)'
}
