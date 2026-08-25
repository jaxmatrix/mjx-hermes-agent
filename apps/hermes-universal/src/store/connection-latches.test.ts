import { beforeEach, describe, expect, it } from 'vitest'

import {
  $latchedConnections,
  __resetConnectionLatches,
  isLatched,
  latchBackendFailure,
  releaseLatch
} from './connection-latches'

const HOST_KEY_ERROR = { kind: 'host-key-changed', message: 'REMOTE HOST IDENTIFICATION HAS CHANGED' }

beforeEach(__resetConnectionLatches)

describe('latchBackendFailure', () => {
  // Desktop states the invariant as a test name, and it is the one that keeps a
  // terminal failure from being retried forever.
  it('gives every remote failure EXACTLY one path: retry, reauth latch, or host-key latch', () => {
    expect(latchBackendFailure('a', { attemptedRemote: true, error: HOST_KEY_ERROR })).toBe('host-key-changed')

    __resetConnectionLatches()
    expect(latchBackendFailure('a', { attemptedRemote: true, error: new Error('401'), isReauth: true })).toBe(
      'reauth-required'
    )

    __resetConnectionLatches()
    // A transient remote fault stays retryable — this is the one that must NOT
    // latch, or a lapsed cookie wedges the app until it is relaunched.
    expect(latchBackendFailure('a', { attemptedRemote: true, error: new Error('ECONNRESET') })).toBeNull()
  })

  it('latches a LOCAL start failure so the install-retry loop is broken', () => {
    expect(latchBackendFailure('local', { attemptedRemote: false, error: new Error('spawn failed') })).toBe(
      'local-start-failed'
    )
  })

  it('recognises a host-key change that crossed a stringifying boundary', () => {
    expect(
      latchBackendFailure('a', { attemptedRemote: true, error: new Error('Host key verification failed') })
    ).toBe('host-key-changed')
  })

  it('is PER CONNECTION, so one dead source does not stand the others down', () => {
    latchBackendFailure('a', { attemptedRemote: true, error: HOST_KEY_ERROR })

    expect(isLatched('a')).toBe('host-key-changed')
    expect(isLatched('b')).toBeNull()
    expect(isLatched(null)).toBeNull()
  })

  it('releases idempotently', () => {
    latchBackendFailure('a', { attemptedRemote: true, error: HOST_KEY_ERROR })

    releaseLatch('a')
    releaseLatch('a')

    expect($latchedConnections.get()).toEqual({})
  })
})
