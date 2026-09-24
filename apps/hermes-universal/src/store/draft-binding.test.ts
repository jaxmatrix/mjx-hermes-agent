/**
 * MJXHRM-591, invariant 42 — exactly one tab may follow the active connection.
 *
 * An UNBOUND draft holds no ref: it renders and routes against whatever the app
 * is pointed at, and a connection switch re-points it. It binds ONCE, at the
 * dispatch of its first `session.create`, to the connection that dispatch went
 * out on — read synchronously, before the await, so a switch during the round
 * trip cannot repoint a chat that was created somewhere else. From that instant
 * it is an ordinary bound tab, and the binding is irreversible.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway-client', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({})
  }
})
vi.mock('@/store/notifications', () => ({
  clearNotifications: vi.fn(),
  notify: vi.fn(),
  notifyError: vi.fn()
}))

import { $activeConnection } from '@/store/active-connection'
import { ensureSession } from '@/store/chat'
import { requestGateway } from '@/store/gateway-client'
import { $activeProfile } from '@/store/profiles'
import {
  $activeSessionKey,
  $sessionKeyStates,
  emptySessionState,
  newDraftKey,
  publishSessionState
} from '@/store/session-state-types'

const activeOn = (connectionId: null | string) =>
  $activeConnection.set(
    connectionId ? ({ connectionId, profile: 'default', scopeKey: connectionId } as unknown as never) : null
  )

const openDraft = () => {
  const key = newDraftKey()

  publishSessionState(key, emptySessionState())
  $activeSessionKey.set(key)

  return key
}

beforeEach(() => {
  $sessionKeyStates.set({})
  $activeProfile.set('default')
  vi.mocked(requestGateway).mockReset()
})

describe('the draft binds at its create dispatch', () => {
  it('binds to the connection the dispatch went out on, keyed by it', async () => {
    activeOn('conn-a')
    openDraft()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'run-1', stored_session_id: 'abc12345' })

    const { id } = await ensureSession()

    expect(id).toBe('run-1')
    expect($sessionKeyStates.get()['@conn-a|run-1']).toMatchObject({
      connectionId: 'conn-a',
      profile: 'default',
      runtimeSessionId: 'run-1',
      storedSessionId: 'abc12345'
    })
    expect($activeSessionKey.get()).toBe('@conn-a|run-1')
  })

  it('is not repointed by a switch that lands DURING the round trip', async () => {
    activeOn('conn-a')
    openDraft()

    // The reply comes back after the user has already moved the app to B.
    vi.mocked(requestGateway).mockImplementation(async () => {
      activeOn('conn-b')

      return { session_id: 'run-1', stored_session_id: 'abc12345' }
    })

    await ensureSession()

    expect($sessionKeyStates.get()['@conn-a|run-1']).toMatchObject({ connectionId: 'conn-a' })
    expect($sessionKeyStates.get()['@conn-b|run-1']).toBeUndefined()
  })

  it('keeps the local connection’s keys bare, as they have always been', async () => {
    activeOn('local')
    openDraft()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'run-1', stored_session_id: 'abc12345' })

    await ensureSession()

    expect($sessionKeyStates.get()['run-1']).toMatchObject({ connectionId: 'local', runtimeSessionId: 'run-1' })
  })

  it('binds to the local scope when the app names no connection at all', async () => {
    activeOn(null)
    openDraft()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'run-1', stored_session_id: 'abc12345' })

    await ensureSession()

    expect($sessionKeyStates.get()['run-1']).toMatchObject({ connectionId: 'local' })
  })
})
