import { describe, expect, it } from 'vitest'

import { maySweep, resolveCanonicalChat } from './canonical'

describe('the canonical Bot Chat ladder', () => {
  it('resumes a live pin', () => {
    expect(resolveCanonicalChat({ lookup: { id: 'pin', title: 'Bot Chat' }, pin: 'pin' })).toEqual({
      kind: 'resume',
      storedId: 'pin'
    })
  })

  it('opens the live TIP of a compaction-rotated pin while KEEPING the durable pin', () => {
    // The pin is a stored id; aliasing is core's job (rule 17). Re-pinning to
    // the tip here would move the anchor on every compaction.
    expect(
      resolveCanonicalChat({ lookup: { id: 'pin', resolvedId: 'tip', title: 'Bot Chat' }, pin: 'pin' })
    ).toEqual({ kind: 'resume-tip', pin: 'pin', storedId: 'tip' })
  })

  it('keeps the pin and offers Retry when a precise hit will not hydrate — never forks', () => {
    expect(
      resolveCanonicalChat({ lookup: { id: 'pin', title: 'Bot Chat' }, pin: 'pin', pinHydrationFailed: true })
    ).toEqual({ kind: 'retry', storedId: 'pin' })
  })

  it('re-pins a definitively dead pin onto the surviving Bot Chat, not onto rows[0]', () => {
    expect(resolveCanonicalChat({ lookup: { id: 'other', title: 'Bot Chat' }, pin: 'gone' })).toEqual({
      kind: 'adopt',
      storedId: 'other'
    })
  })

  it('creates when the pin is gone and there is no history', () => {
    expect(resolveCanonicalChat({ lookup: null, pin: 'gone' })).toEqual({ kind: 'create' })
  })

  it('ADOPTS an existing hidden Bot Chat before minting a second one', () => {
    // Two machines opening the same bot for the first time must not create two
    // canonical chats. The exact-title lookup is what makes it idempotent.
    expect(resolveCanonicalChat({ lookup: { id: 'existing', title: 'Bot Chat' } })).toEqual({
      kind: 'adopt',
      storedId: 'existing'
    })
  })

  it('never claims an ORDINARY session, whatever the lookup answered', () => {
    // An older gateway ignores the `title` param and answers a normal listing,
    // so a one-element result is not proof of a match.
    expect(resolveCanonicalChat({ lookup: { id: 'someones-work', title: 'Refactor the parser' } })).toEqual({
      kind: 'create'
    })
  })

  it('refuses to mint on a FAILED lookup with no pin — that is how a duplicate is born', () => {
    expect(resolveCanonicalChat({ lookupFailed: true })).toEqual({ kind: 'retry', storedId: '' })
  })

  it('keeps the pin through a transient lookup failure', () => {
    expect(resolveCanonicalChat({ lookupFailed: true, pin: 'pin' })).toEqual({ kind: 'resume', storedId: 'pin' })
  })

  it('resumes on the pin alone when nothing was looked up', () => {
    expect(resolveCanonicalChat({ pin: 'pin' })).toEqual({ kind: 'resume', storedId: 'pin' })
  })

  it('creates for a bot with no pin and no history', () => {
    expect(resolveCanonicalChat({ lookup: null })).toEqual({ kind: 'create' })
  })
})

describe('the hide sweep guards', () => {
  // `session.set_hidden` flips a session's WHOLE compression lineage, so a wrong
  // call buries a real conversation and every ancestor of it.
  it('hides only titles this plugin mints', () => {
    expect(maySweep({ owned: true, title: 'Bot Chat' })).toBe(true)
    expect(maySweep({ owned: true, title: 'Group: Ops' })).toBe(true)
    expect(maySweep({ owned: true, title: 'Refactor the parser' })).toBe(false)
  })

  it('never follows a stale pin to a session this plugin does not own', () => {
    expect(maySweep({ owned: false, title: 'Bot Chat' })).toBe(false)
  })

  it('skips a row whose title it could not read, rather than guessing', () => {
    expect(maySweep({ owned: true })).toBe(false)
    expect(maySweep({ owned: true, title: null })).toBe(false)
  })
})
