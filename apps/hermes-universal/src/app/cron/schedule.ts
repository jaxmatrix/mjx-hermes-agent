import type { CronJob } from '@/types/hermes'

// Cron schedule presets (ported from apps/desktop/src/app/cron/index.tsx). Each
// preset maps to a cron expression; 'custom' has none (free-text entry). Labels
// + hints come from i18n (t.cron.scheduleLabels / scheduleHints).
export type SchedulePreset =
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'hourly'
  | 'every-15-minutes'
  | 'custom'

export const SCHEDULE_OPTIONS: ReadonlyArray<{ value: SchedulePreset; expr?: string }> = [
  { value: 'daily', expr: '0 9 * * *' },
  { value: 'weekdays', expr: '0 9 * * 1-5' },
  { value: 'weekly', expr: '0 9 * * 1' },
  { value: 'monthly', expr: '0 9 1 * *' },
  { value: 'hourly', expr: '0 * * * *' },
  { value: 'every-15-minutes', expr: '*/15 * * * *' },
  { value: 'custom' }
]

export const DELIVERY_VALUES = ['local', 'telegram', 'discord', 'slack', 'email'] as const
export type DeliveryTarget = (typeof DELIVERY_VALUES)[number]
export const DEFAULT_DELIVER: DeliveryTarget = 'local'

const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

export function jobName(job: CronJob): string {
  return asText(job.name).trim()
}

export function jobScheduleExpr(job: CronJob): string {
  return asText(job.schedule?.expr) || asText(job.schedule_display) || ''
}

export function jobScheduleDisplay(job: CronJob): string {
  return asText(job.schedule_display) || asText(job.schedule?.display) || asText(job.schedule?.expr) || '—'
}

export function jobDeliver(job: CronJob): DeliveryTarget {
  const value = asText(job.deliver)
  return (DELIVERY_VALUES as readonly string[]).includes(value) ? (value as DeliveryTarget) : DEFAULT_DELIVER
}

/** The preset whose expression matches `expr`, or 'custom' when none does. */
export function presetForExpr(expr: string): SchedulePreset {
  const normalized = expr.trim().replace(/\s+/g, ' ')
  return SCHEDULE_OPTIONS.find(option => option.expr === normalized)?.value ?? 'custom'
}

/** The cron expression for a preset ('' for 'custom' — caller supplies it). */
export function exprForPreset(preset: SchedulePreset): string {
  return SCHEDULE_OPTIONS.find(option => option.value === preset)?.expr ?? ''
}
