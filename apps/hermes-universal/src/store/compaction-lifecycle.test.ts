import { beforeEach, describe, expect, it } from 'vitest'

import { $compactingSessions, sessionCompacting, setSessionCompacting } from './compaction'
import { clearAllCompaction } from './compaction-lifecycle'

describe('clearAllCompaction', () => {
  beforeEach(() => $compactingSessions.set({}))

  it('releases every session at once', () => {
    setSessionCompacting('session-a', true)
    setSessionCompacting('session-b', true)

    clearAllCompaction()

    expect($compactingSessions.get()).toEqual({})
    expect(sessionCompacting('session-a').get()).toBe(false)
  })

  it('does not notify when nothing was compacting', () => {
    const before = $compactingSessions.get()

    clearAllCompaction()

    expect($compactingSessions.get()).toBe(before)
  })
})
