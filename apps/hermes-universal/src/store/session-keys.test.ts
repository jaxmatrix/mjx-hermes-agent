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

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $sessionKeyStates,
  clearStoredIdIndex,
  connectionOfSessionKey,
  emptySessionState,
  hydratingKey,
  hydratingKeyFor,
  parseSessionKey,
  publishSessionState,
  rekeySession,
  runtimeKeyFor,
  runtimeKeyForStoredSession,
  storedKeyFor
} from '@/store/session-state-types'
import { $inflightTurns, beginTurn, settleTurn } from '@/store/turn-lifecycle'

beforeEach(() => {
  $sessionKeyStates.set({})
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
    expect($sessionKeyStates.get()[key]?.storedSessionId).toBe('abc12345')
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
      ...$sessionKeyStates.get()[key],
      connectionId: 'conn-b',
      profile: 'default',
      statusLine: 'still fine'
    })

    expect($sessionKeyStates.get()[key]).toMatchObject({
      connectionId: 'conn-a',
      profile: 'work',
      // …and everything else in that write still lands.
      statusLine: 'still fine'
    })
  })

  it('lets a scopeless draft take one at its binding', () => {
    publishSessionState('draft:9', emptySessionState())
    publishSessionState('draft:9', { ...emptySessionState(), connectionId: 'conn-a', profile: 'work' })

    expect($sessionKeyStates.get()['draft:9']).toMatchObject({ connectionId: 'conn-a', profile: 'work' })
  })
})

describe('invariant 45 — a runtime key\u2019s slice carries its key\u2019s scope', () => {
  it('mints the scope for a slice published without one', () => {
    const key = runtimeKeyFor('conn-a', 'run-1')

    publishSessionState(key, { ...emptySessionState('abc12345'), runtimeSessionId: 'run-1' })

    expect($sessionKeyStates.get()[key]).toMatchObject({ connectionId: 'conn-a', profile: 'default' })
  })

  it('refuses one that claims another connection, and keeps the key\u2019s', () => {
    const key = runtimeKeyFor('conn-a', 'run-1')

    publishSessionState(key, {
      ...emptySessionState('abc12345'),
      // The write is the thing that is wrong; the key is the address.
      connectionId: 'conn-b',
      profile: 'default',
      runtimeSessionId: 'run-1'
    })

    expect($sessionKeyStates.get()[key]?.connectionId).toBe('conn-a')
  })

  it('leaves a placeholder alone — a draft has no scope yet, by design', () => {
    publishSessionState('draft:77', emptySessionState())

    expect($sessionKeyStates.get()['draft:77']?.connectionId).toBeNull()
  })

  it('refuses a rekey that would hand a session to another connection', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const from = hydratingKeyFor({ connectionId: 'conn-a', profile: 'work', storedSessionId: 'abc12345' })

      publishSessionState(from, { ...emptySessionState('abc12345'), connectionId: 'conn-a', profile: 'work' })
      rekeySession(from, runtimeKeyFor('conn-b', 'run-1'), { runtimeSessionId: 'run-1' })

      // The key is the address, so it wins — but silently would leave a slice
      // nobody could explain.
      expect(warn).toHaveBeenCalledWith('[sessions] refusing a rekey across connections', expect.anything())
      expect($sessionKeyStates.get()[runtimeKeyFor('conn-b', 'run-1')]?.connectionId).toBe('conn-b')
    } finally {
      warn.mockRestore()
    }
  })

  it('mints the target key for a rekey handed a bare runtime id', () => {
    const from = hydratingKeyFor({ connectionId: 'conn-a', profile: 'work', storedSessionId: 'abc12345' })

    publishSessionState(from, { ...emptySessionState('abc12345'), connectionId: 'conn-a', profile: 'work' })
    // What every recovery path hands over: the id the wire gave it.
    rekeySession(from, 'run-1', { runtimeSessionId: 'run-1' })

    expect($sessionKeyStates.get()[runtimeKeyFor('conn-a', 'run-1')]).toMatchObject({
      connectionId: 'conn-a',
      profile: 'work'
    })
    expect($sessionKeyStates.get()['run-1']).toBeUndefined()
  })

  it('carries the outgoing scope through a rekey', () => {
    const from = hydratingKeyFor({ connectionId: 'conn-a', profile: 'work', storedSessionId: 'abc12345' })
    const to = runtimeKeyFor('conn-a', 'run-1')

    publishSessionState(from, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-a',
      profile: 'work'
    })
    rekeySession(from, to, { runtimeSessionId: 'run-1' })

    // The seven rekey sites inherit through this one seam.
    expect($sessionKeyStates.get()[to]).toMatchObject({ connectionId: 'conn-a', profile: 'work' })
  })
})
