/**
 * MJXHRM-591 — invariant 36: no frame is misrouted, and none is silently dropped.
 *
 * Two backends mint `uuid4().hex[:8]`, so the same `session_id` arriving on two
 * sockets is ordinary. A frame is placed by the CONNECTION THAT DELIVERED IT
 * plus the id — never by the id alone — and a frame from a background
 * connection is now routed rather than discarded, which is the whole point of a
 * tab bound to one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '@/gateway'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('idle'),
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({})
  }
})
vi.mock('@/components/chat/vibe-hearts', () => ({ burstVibeHearts: vi.fn() }))
vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/completion-sound', () => ({ playCompletionSound: vi.fn() }))

import { $activeConnection } from '@/store/active-connection'
import { resetUnscopedStreamPin, routeGatewayEvent } from '@/store/event-router'
import { connectionEpoch, replayCursor, __testing as replayTesting } from '@/store/session-replay'
import {
  $activeSessionKey,
  $sessionStates,
  emptySessionState,
  publishSessionState,
  runtimeKeyFor
} from '@/store/session-state-types'

const SHARED_ID = 'abc12345'

const frame = (type: string, payload: Record<string, unknown>, connectionId?: string): GatewayEvent =>
  ({ connectionId, payload, session_id: SHARED_ID, type }) as GatewayEvent

const seed = (connectionId: string) => {
  const key = runtimeKeyFor(connectionId, SHARED_ID)

  publishSessionState(key, {
    ...emptySessionState(SHARED_ID),
    connectionId,
    profile: 'default',
    runtimeSessionId: SHARED_ID
  })

  return key
}

/** `status.update` folds straight into the slice, so it reads back without the
 *  delta batcher's flush window — this test is about WHERE a frame lands. */
const statusOf = (key: string) => $sessionStates.get()[key]?.statusLine ?? ''

beforeEach(() => {
  $sessionStates.set({})
  replayTesting.reset()
  resetUnscopedStreamPin()
  $activeConnection.set({ connectionId: 'conn-a', profile: 'default', scopeKey: 'conn-a' } as unknown as never)
})

describe('invariant 36 — a frame is placed by its connection AND its id', () => {
  it('lands connection B’s event in B’s slice, leaving A’s identical id untouched', () => {
    const a = seed('conn-a')
    const b = seed('conn-b')

    $activeSessionKey.set(a)

    routeGatewayEvent(frame('status.update', { text: 'from B' }, 'conn-b'))

    expect(statusOf(b)).toBe('from B')
    expect(statusOf(a)).toBe('')
  })

  it('routes the ambient (unstamped) frame to the active connection’s slice', () => {
    const a = seed('conn-a')
    const b = seed('conn-b')

    $activeSessionKey.set(a)

    routeGatewayEvent(frame('status.update', { text: 'from A' }))

    expect(statusOf(a)).toBe('from A')
    expect(statusOf(b)).toBe('')
  })

  it('does not drop a background connection’s frame the way rule 7 used to', () => {
    const b = seed('conn-b')

    $activeSessionKey.set(runtimeKeyFor('conn-a', 'other'))

    routeGatewayEvent(frame('status.update', { text: 'still delivered' }, 'conn-b'))

    expect(statusOf(b)).toBe('still delivered')
  })

  it('keeps each connection’s unscoped stream pin to itself', () => {
    const a = seed('conn-a')
    const b = seed('conn-b')

    $activeSessionKey.set(a)

    // Both streams open. A's pin is its own slice; B's is its own.
    routeGatewayEvent(frame('message.start', {}))
    routeGatewayEvent(frame('message.start', {}, 'conn-b'))

    // Unscoped frames — no session_id at all — follow their own socket's pin.
    routeGatewayEvent({ payload: { text: 'a-tail' }, type: 'status.update' } as GatewayEvent)
    routeGatewayEvent({ connectionId: 'conn-b', payload: { text: 'b-tail' }, type: 'status.update' } as GatewayEvent)

    expect(statusOf(a)).toBe('a-tail')
    expect(statusOf(b)).toBe('b-tail')
  })

  it('drops an unscoped frame from a background connection that owns no stream', () => {
    const a = seed('conn-a')

    $activeSessionKey.set(a)

    routeGatewayEvent({ connectionId: 'conn-b', payload: { text: 'nobody' }, type: 'status.update' } as GatewayEvent)

    expect(statusOf(a)).toBe('')
  })
})

describe('invariant 35 — the router records what a reconnect will need', () => {
  it('takes each socket\u2019s replay epoch, background ones included', () => {
    routeGatewayEvent({ payload: { replay_epoch: 'e-ambient' }, type: 'gateway.ready' } as GatewayEvent)
    routeGatewayEvent({
      connectionId: 'conn-b',
      payload: { replay_epoch: 'e-b' },
      type: 'gateway.ready'
    } as GatewayEvent)

    expect(connectionEpoch('conn-a')).toBe('e-ambient')
    expect(connectionEpoch('conn-b')).toBe('e-b')
  })

  it('advances the watermark of the session a frame was folded into, and no other', () => {
    const a = seed('conn-a')
    const b = seed('conn-b')

    $activeSessionKey.set(a)

    routeGatewayEvent({
      connectionId: 'conn-b',
      payload: { replay_epoch: 'e-b' },
      type: 'gateway.ready'
    } as GatewayEvent)
    routeGatewayEvent({ ...frame('status.update', { text: 'one' }, 'conn-b'), seq: 4 } as GatewayEvent)
    routeGatewayEvent({ ...frame('status.update', { text: 'two' }, 'conn-b'), seq: 9 } as GatewayEvent)

    expect(replayCursor(b)).toEqual({ epoch: 'e-b', seq: 9 })
    // A's slice exists and has the same stored id: crediting a frame to every
    // open session would hand it a watermark it never saw a frame under.
    expect(replayCursor(a).seq).toBe(0)
  })
})
