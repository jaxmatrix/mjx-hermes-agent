/**
 * MJXHRM-452 — the DURABLE half of "finished — unread".
 *
 * The transient `$unreadFinishedSessionIds` atom dies with the window, so a turn
 * that finished while you were elsewhere — or while the app was closed — was
 * forgotten by the next start. Two persisted records fix that: a per-session
 * watermark (`message_count` last acknowledged) and an explicit marker for the
 * live busy→idle edge, both bucketed BY PROFILE and keyed by the DURABLE lineage
 * id so they survive auto-compression's id rotation.
 *
 * Every case here seeds state that DISAGREES with the assertion: a row that is
 * already unread by count, a marker in the wrong profile's bucket, a watermark
 * for a same-id row that belongs to somebody else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { $activeGatewayProfile } from './profile'
import { $activeStoredSessionId, $messagingSessions, $sessions, $unreadFinishedSessionIds } from './session'
import {
  $sessionSeenCounts,
  $unreadFinishedMarkers,
  ackAllSessionsRead,
  ackStoredSessionId,
  forgetSessionUnread,
  markSessionUnreadFinished,
  watchPersistedUnread
} from './session-unread'

const row = (id: string, patch: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, message_count: 4, ...patch }) as SessionInfo

beforeEach(() => {
  $sessions.set([])
  $messagingSessions.set([])
  $unreadFinishedSessionIds.set([])
  $sessionSeenCounts.set({})
  $unreadFinishedMarkers.set({})
  $activeStoredSessionId.set(null)
  $activeGatewayProfile.set(null)
})

afterEach(() => {
  $sessionSeenCounts.set({})
  $unreadFinishedMarkers.set({})
})

describe('markSessionUnreadFinished', () => {
  it('buckets the marker under the ROW’s profile, not the live gateway’s', () => {
    // The trap: the gateway is on `work` while the finished row belongs to
    // `personal`. An unscoped write would let `work`'s bucket paint (or later
    // silence) a row it does not own.
    $activeGatewayProfile.set('work')
    $sessions.set([row('s1', { profile: 'personal' })])

    markSessionUnreadFinished('s1')

    expect($unreadFinishedMarkers.get()).toEqual({ personal: ['s1'] })
  })

  it('keys the marker on the lineage root, so a compaction cannot orphan it', () => {
    $sessions.set([row('tip', { _lineage_root_id: 'root' })])

    markSessionUnreadFinished('tip')

    expect($unreadFinishedMarkers.get()).toEqual({ default: ['root'] })
  })

  it('falls back to the live gateway’s profile when no row is loaded', () => {
    $activeGatewayProfile.set('work')

    markSessionUnreadFinished('not-listed')

    expect($unreadFinishedMarkers.get()).toEqual({ work: ['not-listed'] })
  })
})

describe('ackStoredSessionId', () => {
  it('watermarks the row at its current count and retires its marker', () => {
    // Seeded to disagree: the watermark is BEHIND the live count (so the row is
    // unread) and a marker is standing.
    $sessions.set([row('s1', { message_count: 9 })])
    $sessionSeenCounts.set({ default: { s1: 2 } })
    $unreadFinishedMarkers.set({ default: ['s1'] })

    ackStoredSessionId('s1')

    expect($sessionSeenCounts.get()).toEqual({ default: { s1: 9 } })
    expect($unreadFinishedMarkers.get()).toEqual({})
  })

  it('leaves another profile’s identically-named session alone', () => {
    $sessions.set([row('shared', { message_count: 9, profile: 'work' })])
    $sessionSeenCounts.set({ personal: { shared: 1 }, work: { shared: 1 } })

    ackStoredSessionId('shared')

    expect($sessionSeenCounts.get()).toEqual({ personal: { shared: 1 }, work: { shared: 9 } })
  })
})

describe('ackAllSessionsRead', () => {
  it('watermarks every loaded row, including messaging rows', () => {
    $sessions.set([row('a', { message_count: 3 }), row('b', { message_count: 7, profile: 'work' })])
    $messagingSessions.set([row('m', { message_count: 11 })])
    $sessionSeenCounts.set({ default: { a: 0 } })
    $unreadFinishedMarkers.set({ default: ['a', 'm'], work: ['b'] })

    ackAllSessionsRead()

    expect($sessionSeenCounts.get()).toEqual({ default: { a: 3, m: 11 }, work: { b: 7 } })
    expect($unreadFinishedMarkers.get()).toEqual({})
  })
})

describe('forgetSessionUnread', () => {
  it('drops every alias of the gone session from one profile’s buckets only', () => {
    $sessionSeenCounts.set({ default: { other: 1, root: 5 }, work: { root: 5 } })
    $unreadFinishedMarkers.set({ default: ['root', 'other'], work: ['root'] })

    forgetSessionUnread(['tip', 'root', null], 'default')

    expect($sessionSeenCounts.get()).toEqual({ default: { other: 1 }, work: { root: 5 } })
    expect($unreadFinishedMarkers.get()).toEqual({ default: ['other'], work: ['root'] })
  })
})

describe('the recompute that survives a restart', () => {
  it('paints a row whose live count has outrun its watermark, and only that row', async () => {
    watchPersistedUnread()

    // `caught-up` is at its watermark; `behind` has moved on since. A recompute
    // that ignored the watermarks would light up both, or neither.
    $sessionSeenCounts.set({ default: { behind: 2, 'caught-up': 6 } })
    $sessions.set([row('behind', { message_count: 9 }), row('caught-up', { message_count: 6 })])

    expect($unreadFinishedSessionIds.get()).toEqual(['behind'])
  })

  it('never paints the session that is on screen', async () => {
    watchPersistedUnread()

    $activeStoredSessionId.set('behind')
    $sessionSeenCounts.set({ default: { behind: 2 } })
    $sessions.set([row('behind', { message_count: 9 })])

    expect($unreadFinishedSessionIds.get()).toEqual([])
  })

  it('seeds an unknown session at its current count instead of lighting it up', async () => {
    watchPersistedUnread()

    $sessions.set([row('fresh', { message_count: 40 })])

    expect($unreadFinishedSessionIds.get()).toEqual([])
    expect($sessionSeenCounts.get()).toEqual({ default: { fresh: 40 } })
  })
})
