/**
 * MJXHRM-591 — invariant 35: replay is epoch-checked.
 *
 * A watermark is only meaningful under the event log it was taken from. Asking
 * `session.events.since` with a number from a PREVIOUS log returns nothing and
 * looks exactly like "you are up to date" — a silently blank catch-up, which is
 * the failure this checks for.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  __testing,
  connectionEpoch,
  forgetReplayCursor,
  noteConnectionEpoch,
  noteReplaySeq,
  planReplay,
  readEventsSince,
  replayCursor
} from '@/store/session-replay'

const KEY = '@conn-b|abc12345'

beforeEach(() => {
  __testing.reset()
})

describe('the watermark', () => {
  it('follows the highest seq this client actually folded', () => {
    noteReplaySeq(KEY, 4, 'e1')
    noteReplaySeq(KEY, 7, 'e1')

    expect(replayCursor(KEY)).toEqual({ epoch: 'e1', seq: 7 })
  })

  it('never moves backwards on a replayed or out-of-order frame', () => {
    noteReplaySeq(KEY, 7, 'e1')
    noteReplaySeq(KEY, 3, 'e1')
    noteReplaySeq(KEY, undefined, 'e1')
    noteReplaySeq(KEY, null, 'e1')

    expect(replayCursor(KEY).seq).toBe(7)
  })

  it('is forgotten with its session', () => {
    noteReplaySeq(KEY, 7, 'e1')
    forgetReplayCursor(KEY)

    expect(replayCursor(KEY)).toEqual({ epoch: null, seq: 0 })
  })
})

describe('the plan a reconnect follows', () => {
  it('asks for what it missed when the epoch is the one it recorded', () => {
    noteReplaySeq(KEY, 12, 'e1')

    expect(planReplay(KEY, 'e1')).toEqual({ kind: 'since', seq: 12 })
  })

  it('resets and resumes when the epoch changed', () => {
    noteReplaySeq(KEY, 12, 'e1')

    expect(planReplay(KEY, 'e2')).toEqual({ kind: 'resume' })
    // …and the stale number is gone, so the next reconnect cannot ask with it.
    expect(replayCursor(KEY)).toEqual({ epoch: 'e2', seq: 0 })
  })

  it('resumes a session it has never stamped a seq for', () => {
    expect(planReplay(KEY, 'e1')).toEqual({ kind: 'resume' })
  })

  it('resumes when the backend names no epoch at all', () => {
    noteReplaySeq(KEY, 12, null)

    expect(planReplay(KEY, undefined)).toEqual({ kind: 'resume' })
  })
})

describe('the answer a since-request brings back', () => {
  it('advances the watermark over the frames it delivered', () => {
    noteReplaySeq(KEY, 12, 'e1')

    expect(readEventsSince(KEY, { events: [{ seq: 13 }, { seq: 14 }] })).toBeNull()
    expect(replayCursor(KEY).seq).toBe(14)
  })

  it('refetches, and drops the watermark, when the log was truncated', () => {
    noteReplaySeq(KEY, 12, 'e1')

    expect(readEventsSince(KEY, { events: [{ seq: 99 }], truncated: true })).toEqual({ kind: 'refetch' })
    // The delivered frames are NOT credited: a partial fold on top of a gap
    // paints a transcript with a hole in it.
    expect(replayCursor(KEY).seq).toBe(0)
  })

  it('says nothing about an answer that never came', () => {
    expect(readEventsSince(KEY, null)).toBeNull()
  })
})

describe('the epoch each connection advertised', () => {
  it('is remembered per connection', () => {
    noteConnectionEpoch('conn-a', 'e1')
    noteConnectionEpoch('conn-b', 'e2')

    expect(connectionEpoch('conn-a')).toBe('e1')
    expect(connectionEpoch('conn-b')).toBe('e2')
    expect(connectionEpoch('conn-c')).toBeNull()
  })
})
