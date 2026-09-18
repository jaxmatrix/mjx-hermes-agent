/**
 * MJXHRM-591, invariants 39 and 40 — what a tab says about its own backend.
 *
 * Two failure modes that are NOT the same thing, and whose verbs must not be
 * swapped: a LOST connection may come back and offers Retry; an UNAVAILABLE tab
 * cannot and offers Close, and only Close. Offering Retry on the second is
 * asking the user to keep pulling a lever with nothing on the end of it.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/platform', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  get IS_MOBILE() {
    return mobile
  }
}))

let mobile = false

import { tabConnectionFor, tabIsBroken, tabIsUnsupportedHere } from '@/store/tab-connection'

describe('a tab on a healthy connection', () => {
  it('says nothing at all', () => {
    expect(tabConnectionFor({ ambient: false, client: { attempt: 0, phase: 'live' }, connectionId: 'conn-a' })).toEqual(
      { kind: 'ok' }
    )
    // A tab on the ACTIVE connection has no owning client: it rides the ambient
    // socket, whose state the app already shows everywhere else.
    expect(tabConnectionFor({ connectionId: 'conn-a' })).toEqual({ kind: 'ok' })
    // A cold dial is 45-90 s and is not a failure.
    expect(tabConnectionFor({ client: { attempt: 2, phase: 'opening' }, connectionId: 'conn-a' })).toEqual({
      kind: 'ok'
    })
  })
})

describe('invariant 46 — a missing hold is not health', () => {
  it('shows a non-ambient tab with no client as not connected', () => {
    // The hold IS the serving: no hold means nothing is carrying this tab's
    // frames, and a tab that looks fine and cannot send is the failure.
    expect(tabConnectionFor({ ambient: false, connectionId: 'conn-a' })).toMatchObject({
      connectionId: 'conn-a',
      kind: 'lost'
    })
  })

  it('leaves an AMBIENT tab alone, which has no hold by design', () => {
    expect(tabConnectionFor({ ambient: true, connectionId: 'conn-a' })).toEqual({ kind: 'ok' })
  })
})

describe('a lost connection', () => {
  it('names the connection and whether retrying can help', () => {
    expect(tabConnectionFor({ client: { attempt: 3, phase: 'degraded' }, connectionId: 'conn-a' })).toMatchObject({
      connectionId: 'conn-a',
      kind: 'lost',
      terminal: false
    })

    expect(
      tabConnectionFor({
        client: { attempt: 0, error: 'sign in', phase: 'lost', terminal: true },
        connectionId: 'conn-a'
      })
    ).toMatchObject({ error: 'sign in', kind: 'lost', terminal: true })
  })
})

describe('an unavailable tab', () => {
  it('outranks a lost connection — there is nothing to come back to', () => {
    const state = tabConnectionFor({
      client: { attempt: 1, phase: 'degraded' },
      connectionId: 'conn-a',
      tile: { unavailable: true }
    })

    expect(state).toEqual({ kind: 'unavailable', reason: 'backend-changed' })
  })

  it('is what a LOCAL tab opens into on a phone, and never on the desktop', () => {
    mobile = true

    expect(tabIsUnsupportedHere('local')).toBe(true)
    expect(tabIsUnsupportedHere(null)).toBe(true)
    expect(tabIsUnsupportedHere('conn-a')).toBe(false)
    expect(tabConnectionFor({ connectionId: 'local' })).toEqual({
      kind: 'unavailable',
      reason: 'unsupported-platform'
    })

    mobile = false

    expect(tabIsUnsupportedHere('local')).toBe(false)
    expect(tabConnectionFor({ connectionId: 'local' })).toEqual({ kind: 'ok' })
  })
})

describe('the red inner border', () => {
  it('is worn by both failure modes and by neither healthy one', () => {
    expect(tabIsBroken({ kind: 'ok' })).toBe(false)
    expect(tabIsBroken({ connectionId: 'conn-a', kind: 'lost', terminal: false })).toBe(true)
    expect(tabIsBroken({ kind: 'unavailable', reason: 'backend-changed' })).toBe(true)
  })
})
