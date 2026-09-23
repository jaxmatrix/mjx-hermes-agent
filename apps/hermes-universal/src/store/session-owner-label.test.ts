import { beforeEach, describe, expect, it } from 'vitest'

import { $sessionOwnerLabels, sessionOwnerLabel, setSessionOwnerLabels, withSessionOwner } from './session-owner-label'

beforeEach(() => {
  $sessionOwnerLabels.set({})
})

describe('the name a session reads under', () => {
  it('shows a named profile’s session under its owner', () => {
    setSessionOwnerLabels({ radar: 'Sentinel' })

    expect(withSessionOwner('Bot Chat', 'radar')).toBe('Sentinel: Bot Chat')
  })

  it('leaves a profile nobody named bare', () => {
    setSessionOwnerLabels({ radar: 'Sentinel' })

    // `scout` shares a prefix with nothing and `default` is the fallback key an
    // unowned row resolves to — neither may borrow the only name there is.
    expect(withSessionOwner('Refactor the parser', 'scout')).toBe('Refactor the parser')
    expect(withSessionOwner('Refactor the parser', null)).toBe('Refactor the parser')
    expect(withSessionOwner('Refactor the parser', '')).toBe('Refactor the parser')
  })

  it('REPLACES the set, so a bot that is gone stops lending its name', () => {
    setSessionOwnerLabels({ radar: 'Sentinel', scout: 'Scout' })
    setSessionOwnerLabels({ scout: 'Scout' })

    expect(sessionOwnerLabel('radar')).toBeUndefined()
    expect(withSessionOwner('Bot Chat', 'scout')).toBe('Scout: Bot Chat')
  })

  it('keys a profile the way a session row names it, and ignores a blank name', () => {
    setSessionOwnerLabels({ ' radar ': 'Sentinel', scout: '   ' })

    expect(withSessionOwner('Bot Chat', 'radar')).toBe('Sentinel: Bot Chat')
    expect(withSessionOwner('Bot Chat', 'scout')).toBe('Bot Chat')
  })

  it('does not rewrite the atom when nothing changed', () => {
    // Every tab re-registers on this atom, and the roster feeding it polls.
    setSessionOwnerLabels({ radar: 'Sentinel' })
    const before = $sessionOwnerLabels.get()

    setSessionOwnerLabels({ radar: 'Sentinel' })

    expect($sessionOwnerLabels.get()).toBe(before)
  })
})
