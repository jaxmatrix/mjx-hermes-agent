/**
 * MJXHRM-591 — session keys carry their scope, and nothing downstream reads it.
 *
 * Invariant 30: keys are INJECTIVE. Backend session ids are `uuid4().hex[:8]`
 *               minted per state.db, so the same id on two connections — or on
 *               two profiles of one connection — is expected rather than
 *               surprising, and the two must never land on one slice.
 * Invariant 31: keys are OPAQUE. Turn lifecycle, prompts, journals and paint
 *               take a key as a string; only `parseSessionKey` reads its shape.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  $sessionStates,
  clearStoredIdIndex,
  connectionOfSessionKey,
  emptySessionState,
  hydratingKey,
  hydratingKeyFor,
  parseSessionKey,
  publishSessionState,
  runtimeKeyFor,
  runtimeKeyForStoredSession,
  storedKeyFor
} from '@/store/session-state-types'
import { $inflightTurns, beginTurn, settleTurn } from '@/store/turn-lifecycle'

beforeEach(() => {
  $sessionStates.set({})
  clearStoredIdIndex()
})

describe('invariant 30 — keys are injective', () => {
  it('keeps the local default scope byte-identical to the legacy key', () => {
    expect(runtimeKeyFor('local', 'abc12345')).toBe('abc12345')
    expect(runtimeKeyFor(null, 'abc12345')).toBe('abc12345')
    expect(runtimeKeyFor('', 'abc12345')).toBe('abc12345')
    expect(storedKeyFor('local', 'default', 'abc12345')).toBe('abc12345')
    expect(storedKeyFor(null, null, 'abc12345')).toBe('abc12345')
    expect(hydratingKey('abc12345')).toBe('hydrating:abc12345')
  })

  it('separates every adversarial pair', () => {
    const keys = [
      // The ordinary collision: one id, two backends.
      runtimeKeyFor('local', 'abc12345'),
      runtimeKeyFor('conn-a', 'abc12345'),
      runtimeKeyFor('conn-b', 'abc12345'),
      // Two profiles of one connection share a gateway but not a database.
      storedKeyFor('conn-a', 'default', 'abc12345'),
      storedKeyFor('conn-a', 'work', 'abc12345'),
      // Separator and marker characters inside every part.
      storedKeyFor('a|b', 'default', 'abc12345'),
      storedKeyFor('a', 'b|default', 'abc12345'),
      storedKeyFor('a', 'default', 'b|abc12345'),
      storedKeyFor('@x', 'default', 'abc12345'),
      storedKeyFor('a', '@x', 'abc12345'),
      storedKeyFor('a', 'default', '@x'),
      // The pair that a naive join would collapse onto one string.
      storedKeyFor('a|b', 'c', 'd'),
      storedKeyFor('a', 'b|c', 'd'),
      storedKeyFor('a', 'b', 'c|d')
    ]

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('round-trips every part through `parseSessionKey`', () => {
    for (const [connectionId, profile, id] of [
      ['conn-a', 'default', 'abc12345'],
      ['a|b', '@x', 'c|d'],
      ['a@|b', 'p r o', 'x y']
    ]) {
      expect(parseSessionKey(storedKeyFor(connectionId, profile, id))).toEqual({ connectionId, id, profile })
      expect(parseSessionKey(runtimeKeyFor(connectionId, id))).toMatchObject({ connectionId, id })
    }

    // A legacy, unscoped key still answers — as the local connection's.
    expect(parseSessionKey('abc12345')).toEqual({ connectionId: 'local', id: 'abc12345', profile: null })
    expect(connectionOfSessionKey(runtimeKeyFor('conn-b', 'abc12345'))).toBe('conn-b')
  })

  it('indexes the same stored id on two connections as two sessions', () => {
    const a = runtimeKeyFor('conn-a', 'run-a')
    const b = runtimeKeyFor('conn-b', 'run-b')

    publishSessionState(a, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-a',
      profile: 'default',
      runtimeSessionId: 'run-a'
    })
    publishSessionState(b, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-b',
      profile: 'default',
      runtimeSessionId: 'run-b'
    })

    expect(runtimeKeyForStoredSession('abc12345', { connectionId: 'conn-a', profile: 'default' })).toBe(a)
    expect(runtimeKeyForStoredSession('abc12345', { connectionId: 'conn-b', profile: 'default' })).toBe(b)
    expect(runtimeKeyForStoredSession('abc12345', { connectionId: 'local', profile: 'default' })).toBeNull()
  })

  it('gives each connection its own hydrating placeholder', () => {
    const a = hydratingKeyFor({ connectionId: 'conn-a', profile: 'default', storedSessionId: 'abc12345' })
    const b = hydratingKeyFor({ connectionId: 'conn-b', profile: 'default', storedSessionId: 'abc12345' })

    expect(a).not.toBe(b)
    expect(a.startsWith('hydrating:')).toBe(true)
    expect(b.startsWith('hydrating:')).toBe(true)
  })
})

describe('invariant 31 — keys are opaque downstream', () => {
  it('carries a scoped key through a turn without reading it', () => {
    const key = runtimeKeyFor('conn-a', 'abc12345')

    publishSessionState(key, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-a',
      profile: 'default',
      runtimeSessionId: 'abc12345'
    })

    beginTurn(key, { prompt: 'hello' })

    expect(Object.keys($inflightTurns.get())).toEqual([key])
    expect($inflightTurns.get()[key]?.prompt).toBe('hello')

    settleTurn(key)

    expect($inflightTurns.get()[key]?.phase).toBe('settled')
    // The bare id — what a downstream split on the separator would have used —
    // never addresses anything.
    expect($inflightTurns.get()['abc12345']).toBeUndefined()
    expect($sessionStates.get()[key]?.storedSessionId).toBe('abc12345')
  })
})

describe('a slice\u2019s scope is written once', () => {
  it('keeps the scope its session was born with', () => {
    const key = runtimeKeyFor('conn-a', 'run-1')

    publishSessionState(key, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-a',
      profile: 'work',
      runtimeSessionId: 'run-1'
    })

    // A later write that names a different backend is the repoint the tab type
    // makes impossible to compile, arriving through the one door left open.
    publishSessionState(key, {
      ...$sessionStates.get()[key],
      connectionId: 'conn-b',
      profile: 'default',
      statusLine: 'still fine'
    })

    expect($sessionStates.get()[key]).toMatchObject({
      connectionId: 'conn-a',
      profile: 'work',
      // …and everything else in that write still lands.
      statusLine: 'still fine'
    })
  })

  it('lets a scopeless draft take one at its binding', () => {
    publishSessionState('draft:9', emptySessionState())
    publishSessionState('draft:9', { ...emptySessionState(), connectionId: 'conn-a', profile: 'work' })

    expect($sessionStates.get()['draft:9']).toMatchObject({ connectionId: 'conn-a', profile: 'work' })
  })
})
