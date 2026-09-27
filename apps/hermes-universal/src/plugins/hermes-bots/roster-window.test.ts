import { describe, expect, it } from 'vitest'

import {
  nextRosterWindow,
  ROSTER_WINDOW_INITIAL,
  ROSTER_WINDOW_STEP,
  takeGatewaySections
} from './roster-window'

describe('roster window', () => {
  it('grows by the step without passing the total', () => {
    expect(nextRosterWindow(ROSTER_WINDOW_INITIAL, 100)).toBe(ROSTER_WINDOW_INITIAL + ROSTER_WINDOW_STEP)
    expect(nextRosterWindow(95, 100)).toBe(100)
    expect(nextRosterWindow(40, 0)).toBe(0)
  })

  it('takes rows across gateway sections in order', () => {
    const sections = [
      { id: 'a', rows: [1, 2, 3] },
      { id: 'b', rows: [4, 5] },
      { id: 'c', rows: [6] }
    ]

    const first = takeGatewaySections(sections, 4)
    expect(first.sections).toEqual([
      { id: 'a', rows: [1, 2, 3] },
      { id: 'b', rows: [4] }
    ])
    expect(first.remaining).toBe(0)

    const withLead = takeGatewaySections(sections, 5, 2)
    expect(withLead.sections).toEqual([{ id: 'a', rows: [1, 2, 3] }])
    expect(withLead.remaining).toBe(0)
  })
})
