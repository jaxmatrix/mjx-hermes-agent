import { beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.hoisted` because the factory runs before module-scope `const`s initialise
// (the trap `app.test.tsx` documents).
const { setApiRequestProfile } = vi.hoisted(() => ({ setApiRequestProfile: vi.fn() }))

vi.mock('@/hermes', () => ({ setApiRequestProfile }))

import { LOCAL_CONNECTION_ID } from '@/lib/backend-scope'
import type { Connection } from '@/store/gateway-config'

import {
  $activeConnection,
  $activeConnectionId,
  describeConnection,
  publishActiveConnection,
  setPendingConnectionHint,
  takePendingConnectionHint,
  withFailOpenDescriptor
} from './active-connection'
import { $connection } from './connection-atoms'
import { $gatewayMode } from './gateway-switch'

const REMOTE: Connection = { authMode: 'none', baseUrl: 'https://gw.test', mode: 'remote' }

beforeEach(() => {
  setApiRequestProfile.mockClear()
  takePendingConnectionHint()
  publishActiveConnection(null)
})

describe('publishActiveConnection', () => {
  // The torn read, closed. Four writes with awaits between them is what let
  // `api()` fire REST at the new base while the UI still said "connecting".
  it('fires exactly ONE notification for a subscriber watching every derived value', () => {
    const seen: string[] = []
    const record = (label: string) => () => seen.push(label)

    const stop = [
      $activeConnection.listen(record('active')),
      $connection.listen(record('connection')),
      $gatewayMode.listen(record('mode'))
    ]

    publishActiveConnection(describeConnection({ ...REMOTE, mode: 'cloud', profile: 'work' }))

    for (const off of stop) {
      off()
    }

    // Three atoms, one batch: every listener runs once, not once per write.
    expect(seen.sort()).toEqual(['active', 'connection', 'mode'])
  })

  it('moves the REST scope with the identity, and leaves it alone on a disconnect', () => {
    publishActiveConnection(describeConnection({ ...REMOTE, profile: 'work' }))
    expect(setApiRequestProfile).toHaveBeenCalledWith('work')

    publishActiveConnection(describeConnection(REMOTE))
    expect(setApiRequestProfile).toHaveBeenLastCalledWith(null)

    setApiRequestProfile.mockClear()
    publishActiveConnection(null)
    // A disconnect is not a profile change: resetting the scope here would
    // diverge from the persisted `$activeProfile` that store/profiles.ts owns.
    expect(setApiRequestProfile).not.toHaveBeenCalled()
  })
})

describe('$activeConnectionId', () => {
  it('does NOT fall back to a registry primary', () => {
    expect($activeConnectionId.get()).toBeNull()

    publishActiveConnection(describeConnection(REMOTE, { connectionId: 'box-2', dialConnectionId: 'box-2', label: 'Box' }))
    expect($activeConnectionId.get()).toBe('box-2')
  })
})

describe('describeConnection', () => {
  it('keeps the BARE scope key with no hint, which is the whole upgrade story', () => {
    const described = describeConnection({ ...REMOTE, profile: 'work' })

    expect(described.dialConnectionId).toBeNull()
    expect(described.scopeKey).toBe('work')
    expect(described.connectionId).toBe(REMOTE.baseUrl)
  })

  it('namespaces a registered source', () => {
    const described = describeConnection(REMOTE, {
      connectionId: 'box-2',
      dialConnectionId: 'box-2',
      label: 'Studio'
    })

    expect(described.scopeKey).toBe('conn:box-2::default')
    expect(described.label).toBe('Studio')
  })

  it('collapses a local connection to the local id', () => {
    expect(describeConnection({ ...REMOTE, mode: 'local' }).connectionId).toBe(LOCAL_CONNECTION_ID)
  })
})

describe('the dial hint', () => {
  it('is one-shot, so a later ambient reconnect cannot inherit a stale identity', () => {
    setPendingConnectionHint({ connectionId: 'box-2', dialConnectionId: 'box-2', label: 'Box' })

    expect(takePendingConnectionHint()?.connectionId).toBe('box-2')
    expect(takePendingConnectionHint()).toBeNull()
  })
})

describe('withFailOpenDescriptor', () => {
  // Desktop's fail-CLOSED publish (#89483) turned registry churn into dead
  // clicks (#89622) and was reverted. Universal inherits the conclusion.
  it('returns null instead of throwing when the lookup rejects', async () => {
    const outcome = await withFailOpenDescriptor(Promise.reject(new Error('gone')), Promise.resolve('dialled'))

    expect(outcome.descriptor).toBeNull()
    expect(outcome.activated).toBe('dialled')
  })

  it('resolves both concurrently, so nothing awaits between activation and publication', async () => {
    const order: string[] = []

    const lookup = new Promise<null>(resolve => {
      order.push('lookup-started')
      setTimeout(() => resolve(null), 0)
    })

    const activate = new Promise<string>(resolve => {
      order.push('activate-started')
      setTimeout(() => resolve('ok'), 0)
    })

    await withFailOpenDescriptor(lookup, activate)

    expect(order).toEqual(['lookup-started', 'activate-started'])
  })
})
