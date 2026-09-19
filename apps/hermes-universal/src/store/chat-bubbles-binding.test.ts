/**
 * MJXHRM-591, invariant 44 — a bubble is addressed by its ref, never by a bare
 * stored id.
 *
 * Bubbles ARE the mobile tab strip, so they take the same treatment as tiles:
 * the ref, the key, the flat ref-shaped persistence and the one-way migration
 * all come from `store/tab-ref`, and a profile switch leaves them where they
 * are. The two STORES stay apart — tiles are coupled to the layout tree, a
 * bubble row is an ordered strip — and this pins the half that could drift.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/session-lifecycle', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $activeStoredSessionId: atom<null | string>(null),
    newSession: vi.fn(),
    openSession: vi.fn(),
    sameStoredSession: (a: null | string, b: null | string) => Boolean(a && b && a === b)
  }
})

import { readKey, writeKey } from '@/lib/persist'
import {
  $chatBubbles,
  addBubble,
  bubbleRuntimeKey,
  __testing as bubbleTesting,
  type ChatBubble,
  migrateLegacyBubbles
} from '@/store/chat-bubbles'
import { $activeProfile } from '@/store/profiles'
import { $activeStoredSessionId } from '@/store/session-lifecycle'
import { $sessionKeyStates, emptySessionState, publishSessionState, runtimeKeyFor } from '@/store/session-state-types'
import { setTabRefResolver, tabKeyFor } from '@/store/tab-ref'

const BUBBLES_V1 = 'hermes.chatBubbles.v1'
const BUBBLES_V2 = 'hermes.chatBubbles.v2'

const bubble = (connectionId: string, profile: string, storedSessionId: string): ChatBubble => ({
  connectionId,
  profile,
  storedSessionId,
  tabKey: tabKeyFor({ connectionId, profile, storedSessionId })
})

beforeEach(() => {
  writeKey(BUBBLES_V1, null)
  writeKey(BUBBLES_V2, null)
  bubbleTesting.reset()
  $sessionKeyStates.set({})
  $activeStoredSessionId.set(null)
  $activeProfile.set('default')
  setTabRefResolver(storedSessionId => ({ connectionId: 'local', profile: 'default', storedSessionId }))
})

describe('a bubble carries its connection', () => {
  it('resolves to its OWN connection’s slice when two backends share an id', () => {
    const a = bubble('conn-a', 'default', 'abc12345')
    const b = bubble('conn-b', 'default', 'abc12345')

    $chatBubbles.set([a, b])

    const keyA = runtimeKeyFor('conn-a', 'run-a')
    const keyB = runtimeKeyFor('conn-b', 'run-b')

    publishSessionState(keyA, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-a',
      profile: 'default',
      runtimeSessionId: 'run-a'
    })
    publishSessionState(keyB, {
      ...emptySessionState('abc12345'),
      connectionId: 'conn-b',
      profile: 'default',
      runtimeSessionId: 'run-b'
    })

    // Both bubbles name the same stored id; each must find its own session.
    expect($chatBubbles.get().map(one => one.tabKey)).toEqual([a.tabKey, b.tabKey])
    expect(bubbleRuntimeKey('abc12345')).toBe(keyA)
  })

  it('records the full ref when a row is opened in a bubble', () => {
    setTabRefResolver(storedSessionId => ({ connectionId: 'conn-b', profile: 'work', storedSessionId }))
    addBubble('abc12345')

    expect($chatBubbles.get().at(-1)).toMatchObject({
      connectionId: 'conn-b',
      profile: 'work',
      storedSessionId: 'abc12345'
    })
  })

  it('stays put across a profile switch', () => {
    $chatBubbles.set([bubble('conn-a', 'default', 'abc12345'), bubble('conn-b', 'work', 'def67890')])

    $activeProfile.set('other')
    $activeProfile.set('default')

    expect($chatBubbles.get().map(one => one.storedSessionId)).toEqual(['abc12345', 'def67890'])
  })
})

describe('the v1 migration', () => {
  it('assigns the registry primary and keeps the profile the bubble sat under', () => {
    writeKey(BUBBLES_V1, JSON.stringify({ default: ['abc12345'], work: ['def67890'] }))

    migrateLegacyBubbles('conn-a')

    expect(JSON.parse(readKey(BUBBLES_V2) ?? '[]')).toEqual([
      { connectionId: 'conn-a', profile: 'default', storedSessionId: 'abc12345' },
      { connectionId: 'conn-a', profile: 'work', storedSessionId: 'def67890' }
    ])
    expect($chatBubbles.get().map(one => one.tabKey)).toEqual([
      tabKeyFor({ connectionId: 'conn-a', profile: 'default', storedSessionId: 'abc12345' }),
      tabKeyFor({ connectionId: 'conn-a', profile: 'work', storedSessionId: 'def67890' })
    ])
  })

  it('is one-way: v1 is gone and a second run resurrects nothing', () => {
    writeKey(BUBBLES_V1, JSON.stringify({ default: ['abc12345'] }))

    migrateLegacyBubbles('conn-a')
    expect(readKey(BUBBLES_V1)).toBeNull()

    bubbleTesting.reset()
    migrateLegacyBubbles('conn-a')

    expect($chatBubbles.get()).toEqual([])
  })

  it('keeps the local connection’s keys bare', () => {
    writeKey(BUBBLES_V1, JSON.stringify({ default: ['abc12345'] }))

    migrateLegacyBubbles('local')

    expect($chatBubbles.get()[0].tabKey).toBe('abc12345')
  })
})
