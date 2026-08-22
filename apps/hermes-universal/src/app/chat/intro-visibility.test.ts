import { describe, expect, it } from 'vitest'

import { hydratingKey, newDraftKey } from '@/store/session-state-types'

import { shouldShowIntro } from './intro-visibility'

// Real keys from the real minters, not hand-written strings: the predicate's
// "fresh draft" clause IS the key-prefix contract, so a test that spells the
// prefix itself would keep passing after `newDraftKey` changed shape.
const DRAFT_KEY = newDraftKey()
const HYDRATING_KEY = hydratingKey('stored-session-7')
const RUNTIME_KEY = 'ses_01JABCDEF'

const showing = {
  enabled: true,
  primaryWindow: true,
  sessionKey: DRAFT_KEY,
  transcriptEmpty: true
} as const

describe('shouldShowIntro', () => {
  it('shows on a fresh empty draft in the primary window', () => {
    expect(shouldShowIntro(showing)).toBe(true)
  })

  it('hides when the Appearance toggle is off', () => {
    expect(shouldShowIntro({ ...showing, enabled: false })).toBe(false)
  })

  it('keeps the toggle authoritative over every other clause', () => {
    // Off means off: no window, session or transcript state re-enables it. Each
    // fixture flips a clause the OTHER way from what it needs to hide, so only
    // `enabled` can be doing the work.
    for (const input of [
      { ...showing, enabled: false, primaryWindow: true },
      { ...showing, enabled: false, sessionKey: DRAFT_KEY },
      { ...showing, enabled: false, transcriptEmpty: true }
    ]) {
      expect(shouldShowIntro(input)).toBe(false)
    }
  })

  it('hides in a satellite / tile window', () => {
    expect(shouldShowIntro({ ...showing, primaryWindow: false })).toBe(false)
  })

  it('hides on a session that is not a fresh draft', () => {
    // A resumed session and a session still hydrating both own the view.
    expect(shouldShowIntro({ ...showing, sessionKey: RUNTIME_KEY })).toBe(false)
    expect(shouldShowIntro({ ...showing, sessionKey: HYDRATING_KEY })).toBe(false)
    expect(shouldShowIntro({ ...showing, sessionKey: null })).toBe(false)
  })

  it('does not flash while a stored session hydrates into an empty transcript', () => {
    // The cold-open shape: transcript still empty, toggle on, primary window —
    // everything says "show" except the key, which is what has to carry it.
    expect(
      shouldShowIntro({ enabled: true, primaryWindow: true, sessionKey: HYDRATING_KEY, transcriptEmpty: true })
    ).toBe(false)
  })

  it('hides once the transcript has anything in it', () => {
    // Includes a cached tail painted before the resume lands (MJXHRM-480): the
    // rows are in `messages`, so the draft key alone must not re-show the splash.
    expect(shouldShowIntro({ ...showing, transcriptEmpty: false })).toBe(false)
  })

  it('decides per surface, so one empty tile can show it while another does not', () => {
    const emptyTile = { ...showing, sessionKey: newDraftKey(), transcriptEmpty: true }
    const busyTile = { ...showing, sessionKey: RUNTIME_KEY, transcriptEmpty: false }

    expect(shouldShowIntro(emptyTile)).toBe(true)
    expect(shouldShowIntro(busyTile)).toBe(false)
  })
})
