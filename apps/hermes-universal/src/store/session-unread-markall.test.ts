/**
 * MJXHRM-452 — "Mark all as read" has to FLUSH the persisted layer.
 *
 * The transient atom and the durable watermarks are two sources for one dot.
 * Clearing only the atom looked right until the next list refresh recomputed
 * every dot the user had just dismissed straight back out of the watermarks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: vi.fn()
  }
})

import type { SessionInfo } from '@/types/hermes'

import { $activeStoredSessionId, $messagingSessions, $sessions, markAllSessionsRead } from './session'
import { $sessionSeenCounts, $unreadFinishedMarkers, watchPersistedUnread } from './session-unread'

const row = (id: string, count: number): SessionInfo => ({ id, message_count: count }) as SessionInfo

beforeEach(() => {
  $activeStoredSessionId.set(null)
  $messagingSessions.set([])
  $sessionSeenCounts.set({})
  $unreadFinishedMarkers.set({})
})

describe('markAllSessionsRead', () => {
  it('advances the watermarks so the next refresh does not repaint the dots', () => {
    watchPersistedUnread()

    // Seeded to disagree: both rows are unread by watermark AND by marker.
    $sessions.set([row('a', 9), row('b', 5)])
    $sessionSeenCounts.set({ default: { a: 1, b: 1 } })
    $unreadFinishedMarkers.set({ default: ['a', 'b'] })

    markAllSessionsRead()

    expect($sessionSeenCounts.get()).toEqual({ default: { a: 9, b: 5 } })
    expect($unreadFinishedMarkers.get()).toEqual({})
  })
})
