import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({ getActionStatus: vi.fn() }))

import { getActionStatus } from '@/hermes'

import { runAction } from './action-poll'

const status = vi.mocked(getActionStatus)

describe('runAction', () => {
  it('spawns then resolves ok on a zero exit code', async () => {
    status.mockResolvedValueOnce({ running: false, exit_code: 0, lines: ['done'], name: 'a', pid: 1 })
    const res = await runAction(async () => ({ name: 'a' }))
    expect(res.ok).toBe(true)
    expect(res.lines).toEqual(['done'])
    expect(status).toHaveBeenCalledWith('a')
  })

  it('resolves not-ok on a non-zero exit code', async () => {
    status.mockResolvedValueOnce({ running: false, exit_code: 2, lines: [], name: 'a', pid: 1 })
    const res = await runAction(async () => ({ name: 'a' }))
    expect(res.ok).toBe(false)
  })

  it('treats a null exit code (still-open) as ok', async () => {
    status.mockResolvedValueOnce({ running: false, exit_code: null, lines: [], name: 'a', pid: 1 })
    const res = await runAction(async () => ({ name: 'a' }))
    expect(res.ok).toBe(true)
  })
})
