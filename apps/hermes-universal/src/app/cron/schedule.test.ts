import { describe, expect, it } from 'vitest'

import type { CronJob } from '@/types/hermes'

import { exprForPreset, jobDeliver, jobScheduleExpr, presetForExpr } from './schedule'

describe('cron schedule helpers', () => {
  it('maps a known expression to its preset', () => {
    expect(presetForExpr('0 9 * * *')).toBe('daily')
    expect(presetForExpr('*/15 * * * *')).toBe('every-15-minutes')
    expect(presetForExpr('0  9  1  *  *')).toBe('monthly') // collapses whitespace
  })

  it('falls back to custom for an unknown expression', () => {
    expect(presetForExpr('30 7 * * 3')).toBe('custom')
  })

  it('resolves a preset to its expression (custom → empty)', () => {
    expect(exprForPreset('hourly')).toBe('0 * * * *')
    expect(exprForPreset('custom')).toBe('')
  })

  it('reads the schedule expr and delivery target from a job', () => {
    const job = { id: '1', enabled: true, schedule: { expr: '0 9 * * 1-5' }, deliver: 'telegram' } as CronJob
    expect(jobScheduleExpr(job)).toBe('0 9 * * 1-5')
    expect(jobDeliver(job)).toBe('telegram')
    expect(jobDeliver({ id: '2', enabled: true } as CronJob)).toBe('local') // default
    expect(jobDeliver({ id: '3', enabled: true, deliver: 'bogus' } as CronJob)).toBe('local')
  })
})
