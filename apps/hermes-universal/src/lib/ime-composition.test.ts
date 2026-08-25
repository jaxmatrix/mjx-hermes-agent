import { describe, expect, it } from 'vitest'

import { isImeCommitEnter, reconcileCompositionFlag } from './ime-composition'

const flag = (value: boolean) => ({ current: value })

describe('reconcileCompositionFlag', () => {
  it('does not arm the heal before the engine has proven it stamps isComposing', () => {
    // WebKitGTK shape: the ref is wedged, the native flag is false, and the
    // engine has never been observed stamping it. Healing here would be a
    // guess, and a wrong guess sends half-composed text.
    const composing = flag(true)
    const trusted = flag(false)

    reconcileCompositionFlag(composing, trusted, false)

    expect(composing.current).toBe(true)
  })

  it('arms the heal when the engine stamps isComposing during a live composition', () => {
    const composing = flag(true)
    const trusted = flag(false)

    reconcileCompositionFlag(composing, trusted, true)

    expect(trusted.current).toBe(true)
  })

  it('leaves a live composition alone on the keydown that arms it', () => {
    const composing = flag(true)
    const trusted = flag(false)

    reconcileCompositionFlag(composing, trusted, true)

    expect(composing.current).toBe(true)
  })

  it('clears a wedged flag once the engine is trusted', () => {
    // Chromium shape: the first keydown of the composition armed the heal, then
    // compositionend went missing and the next keydown says not-composing.
    const composing = flag(true)
    const trusted = flag(false)

    reconcileCompositionFlag(composing, trusted, true)
    reconcileCompositionFlag(composing, trusted, false)

    expect(composing.current).toBe(false)
  })

  it('never sets the flag — it only ever clears one', () => {
    const composing = flag(false)
    const trusted = flag(true)

    reconcileCompositionFlag(composing, trusted, true)

    expect(composing.current).toBe(false)
  })
})

describe('isImeCommitEnter', () => {
  it('recognises the post-compositionend commit Enter', () => {
    expect(isImeCommitEnter({ key: 'Enter', keyCode: 229 })).toBe(true)
  })

  it('lets a real Enter through', () => {
    expect(isImeCommitEnter({ key: 'Enter', keyCode: 13 })).toBe(false)
  })

  it('does not swallow other keys carrying 229', () => {
    expect(isImeCommitEnter({ key: 'a', keyCode: 229 })).toBe(false)
  })
})
