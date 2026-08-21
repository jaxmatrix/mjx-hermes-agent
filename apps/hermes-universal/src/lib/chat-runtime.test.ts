/**
 * `parseCommandDispatch` is the only thing standing between a `slash.exec`
 * result and the composer, and it narrows by KEY: a field it does not name is
 * dropped silently, with a green typecheck and no runtime signal.
 */

import { describe, expect, it } from 'vitest'

import { parseCommandDispatch, parseSlashCommand } from './chat-runtime'

describe('parseCommandDispatch', () => {
  // MJXHRM-444 / the 08-20 sync: `/goal resume` used to answer `exec`
  // (display-only, so nothing re-entered the conversation loop) and now answers
  // `send` carrying BOTH the model-facing continuation prompt and the concise
  // `display` the transcript should show. Universal kept `message` and `notice`
  // and dropped `display`, so a resumed goal read back as the scaffolding.
  it('keeps the display label a send directive carries', () => {
    expect(
      parseCommandDispatch({
        type: 'send',
        message: 'Continuing now — taking the next step toward: ship the thing',
        notice: '▶ Goal resumed',
        display: '/goal resume'
      })
    ).toEqual({
      type: 'send',
      message: 'Continuing now — taking the next step toward: ship the thing',
      notice: '▶ Goal resumed',
      display: '/goal resume'
    })
  })

  it('keeps it on a skill directive too', () => {
    expect(parseCommandDispatch({ type: 'skill', name: 'review', message: 'long prompt', display: '/review' })).toEqual(
      { type: 'skill', name: 'review', message: 'long prompt', display: '/review' }
    )
  })

  it('leaves display undefined when the backend sent none, rather than inventing an empty label', () => {
    expect(parseCommandDispatch({ type: 'send', message: 'go' })).toEqual({
      type: 'send',
      message: 'go',
      notice: undefined,
      display: undefined
    })
  })

  it('refuses a send with no message — there would be nothing to submit', () => {
    expect(parseCommandDispatch({ type: 'send', display: '/goal resume' })).toBeNull()
  })

  it('refuses anything that is not a known directive', () => {
    expect(parseCommandDispatch({ type: 'teleport' })).toBeNull()
    expect(parseCommandDispatch(null)).toBeNull()
    expect(parseCommandDispatch('exec')).toBeNull()
  })
})

describe('parseSlashCommand', () => {
  // `.*$` failed the whole match on any newline, so every multiline slash
  // command parsed as an empty name and was swallowed.
  it('splits a name off an argument that spans newlines', () => {
    expect(parseSlashCommand('/goal ship the thing\nand then rest')).toEqual({
      name: 'goal',
      arg: 'ship the thing\nand then rest'
    })
  })
})
