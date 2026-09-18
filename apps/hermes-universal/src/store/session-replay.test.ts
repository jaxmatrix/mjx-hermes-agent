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
  commitReplayCursor,
  connectionEpoch,
  forgetReplayCursor,
  noteConnectionEpoch,
  noteReplaySeq,
  planReplay,
  readEventsSince,
  type ReplayCursor,
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

    expect(planReplay(KEY, 'e1')).toEqual({ epoch: 'e1', kind: 'since', seq: 12 })
  })

  it('resumes when the epoch changed, without touching the watermark', () => {
    noteReplaySeq(KEY, 12, 'e1')

    expect(planReplay(KEY, 'e2')).toEqual({ kind: 'resume' })
    // PURE (Design v1.3, N10): planning commits nothing, so a plan that never
    // runs cannot leave a cursor claiming frames this client never applied. The
    // resume it asks for is what replaces the watermark.
    expect(replayCursor(KEY)).toEqual({ epoch: 'e1', seq: 12 })
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
  it('hands back a cursor over the frames it delivered, committed by the caller', () => {
    noteReplaySeq(KEY, 12, 'e1')

    const verdict = readEventsSince(KEY, { epoch: 'e1', events: [{ seq: 13 }, { seq: 14 }] }, 'e1')

    expect(verdict).toEqual({ cursor: { epoch: 'e1', seq: 14 }, kind: 'since' })
    // Not yet: the caller commits once it has folded them.
    expect(replayCursor(KEY).seq).toBe(12)

    commitReplayCursor(KEY, (verdict as { cursor: ReplayCursor }).cursor)

    expect(replayCursor(KEY).seq).toBe(14)
  })

  it('resumes when the answer came from a DIFFERENT log than the plan asked under', () => {
    noteReplaySeq(KEY, 12, 'e1')

    // A restart between this connection's `gateway.ready` and this request: every
    // seq in the answer addresses a ring this client has never seen.
    expect(readEventsSince(KEY, { epoch: 'e2', events: [{ seq: 1 }] }, 'e1')).toEqual({ kind: 'resume' })
  })

  it('resumes on a parked question, which the ring cannot carry', () => {
    noteReplaySeq(KEY, 12, 'e1')

    const answer = {
      epoch: 'e1',
      events: [],
      // The REAL snapshot shape: a JSON-RPC request, not an event.
      open_requests: [{ id: 7, method: 'approval', params: { session_id: 'run-1' } }]
    }

    expect(readEventsSince(KEY, answer, 'e1')).toEqual({ kind: 'resume' })
  })

  it('refetches when the log was truncated, crediting nothing', () => {
    noteReplaySeq(KEY, 12, 'e1')

    expect(readEventsSince(KEY, { epoch: 'e1', events: [{ seq: 99 }], truncated: true }, 'e1')).toEqual({
      kind: 'refetch'
    })
    // The delivered frames are NOT credited: a partial fold on top of a gap
    // paints a transcript with a hole in it.
    expect(replayCursor(KEY).seq).toBe(12)
  })

  it('refetches when no answer came at all', () => {
    expect(readEventsSince(KEY, null, 'e1')).toEqual({ kind: 'refetch' })
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
