/**
 * When the tail is written, when the alias is left behind, and what
 * `awaitSessionPainted` counts as "this session is on screen".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import { __resetTranscriptTailCache, readTranscriptTail, saveTranscriptTail } from '@/lib/transcript-tail-cache'
import {
  $sessionStates,
  ensureSessionSlice,
  hydratingKey,
  rekeySession,
  updateSession
} from '@/store/session-state-types'
import { __resetTranscriptCacheSync, awaitSessionPainted, SessionWakeError } from '@/store/transcript-cache-sync'
import { __resetTranscriptPaint, paintCachedTail } from '@/store/transcript-paint'
import { beginTurn, settleTurn } from '@/store/turn-lifecycle'

const row = (id: string, body: string): ChatMessage => ({ id, parts: [{ text: body, type: 'text' }], role: 'user' })

/** The throttle plus the idle/macrotask deferral the save rides on. */
const flushSaves = async () => {
  await vi.advanceTimersByTimeAsync(1_100)
  await vi.advanceTimersByTimeAsync(50)
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  $sessionStates.set({})
  __resetTranscriptTailCache()
  __resetTranscriptPaint()
  __resetTranscriptCacheSync()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('cache writes', () => {
  it('writes the tail when a turn settles, once, after the throttle', async () => {
    ensureSessionSlice('runtime-1', { storedSessionId: 'stored-1' })
    updateSession('runtime-1', state => ({ ...state, messages: [row('m1', 'answer')] }))

    beginTurn('runtime-1', { origin: 'local', prompt: 'q' })
    settleTurn('runtime-1')

    // Nothing on the settle frame: the write is deferred off it deliberately.
    expect(readTranscriptTail('stored-1')).toBeNull()

    await flushSaves()
    expect(readTranscriptTail('stored-1')?.map(m => m.id)).toEqual(['m1'])
  })

  // The cold-open rekey is the richest correct copy the app ever holds: REST
  // (the authority) reconciled with the local live tail and folded with the
  // crash journal.
  it('writes the tail when a hydrating key binds its runtime id', async () => {
    const key = hydratingKey('stored-1')

    ensureSessionSlice(key, { busy: true, storedSessionId: 'stored-1' })
    rekeySession(key, 'runtime-1', {
      messages: [row('rest-1', 'history')],
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'stored-1'
    })

    await flushSaves()
    expect(readTranscriptTail('stored-1')?.map(m => m.id)).toEqual(['rest-1'])
  })

  it('does not write for a draft taking its issued id — there is no history yet', async () => {
    ensureSessionSlice('draft:1', {})
    rekeySession('draft:1', 'runtime-1', { runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })

    await flushSaves()
    expect(readTranscriptTail('stored-1')).toBeNull()
  })

  it('never writes an empty transcript', async () => {
    ensureSessionSlice('runtime-1', { storedSessionId: 'stored-1' })
    beginTurn('runtime-1', { origin: 'local', prompt: 'q' })
    settleTurn('runtime-1')

    await flushSaves()
    expect(readTranscriptTail('stored-1')).toBeNull()
  })

  // MJX-133: an auto-compaction rotates the stored id, and every tile, pane id
  // and persisted blob still names the id from before it.
  it('leaves a one-hop alias behind when the stored id rotates', async () => {
    ensureSessionSlice('runtime-1', { storedSessionId: 'stored-old' })
    updateSession('runtime-1', state => ({ ...state, messages: [row('m1', 'before')] }))
    beginTurn('runtime-1', { origin: 'local', prompt: 'q' })
    settleTurn('runtime-1')
    await flushSaves()

    updateSession('runtime-1', state => ({
      ...state,
      messages: [row('m2', 'after')],
      storedSessionId: 'stored-new'
    }))
    beginTurn('runtime-1', { origin: 'local', prompt: 'q2' })
    settleTurn('runtime-1')
    await flushSaves()

    expect(readTranscriptTail('stored-new')?.map(m => m.id)).toEqual(['m2'])
    // The surface still holding the pre-rotation id resolves to the same tail.
    expect(readTranscriptTail('stored-old')?.map(m => m.id)).toEqual(['m2'])
  })
})

describe('awaitSessionPainted', () => {
  // `publishSessionState` notifies subscribers BEFORE it updates the stored-id
  // reverse index, so a waiter that resolved through the index would miss the
  // very publish that created the slice and then wait forever, because no second
  // publish is coming.
  it('wakes on the same publish that creates the slice', async () => {
    const wake = awaitSessionPainted('stored-fresh')

    ensureSessionSlice('runtime-fresh', { runtimeSessionId: 'runtime-fresh', storedSessionId: 'stored-fresh' })

    await expect(wake).resolves.toBeUndefined()
  })

  it('completes on the runtime binding for an expected-empty session', async () => {
    const wake = awaitSessionPainted('stored-1')

    ensureSessionSlice('runtime-1', { runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })

    await expect(wake).resolves.toBeUndefined()
  })

  // The sequencing rule this seam exists to keep singular: a history-bearing
  // chat completes on TRANSCRIPT PAINT, not on the runtime being bound.
  it('waits for the transcript when history is expected', async () => {
    ensureSessionSlice('runtime-1', { runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })

    let done = false
    const wake = awaitSessionPainted('stored-1', { expectHistory: true }).then(() => (done = true))

    await vi.advanceTimersByTimeAsync(500)
    expect(done).toBe(false)

    updateSession('runtime-1', state => ({ ...state, messages: [row('m1', 'history')] }))
    await wake
    expect(done).toBe(true)
  })

  // A cached tail IS something real on screen — that is the whole point of
  // paint-first: the wake completes on the picture, not on the round trip.
  it('completes on a painted cached tail, before the authoritative rows land', async () => {
    saveTranscriptTail('stored-1', [row('cached', 'last screen')])
    __resetTranscriptTailCache()

    const key = hydratingKey('stored-1')

    ensureSessionSlice(key, { busy: true, runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })

    const wake = awaitSessionPainted('stored-1', { expectHistory: true })

    expect(paintCachedTail(key, 'stored-1')).toBe(true)
    await expect(wake).resolves.toBeUndefined()
  })

  // Desktop #89556: a dial that never handshakes must not be able to consume the
  // transcript's budget, so the two phases carry separate timers and the error
  // says which one ran out.
  it('times out in the activation phase when nothing ever binds', async () => {
    const wake = awaitSessionPainted('stored-1', { timeoutMs: 1_000 }).catch((e: unknown) => e)

    await vi.advanceTimersByTimeAsync(1_100)

    const error = (await wake) as SessionWakeError

    expect(error).toBeInstanceOf(SessionWakeError)
    expect(error).toMatchObject({ phase: 'activation', reason: 'timeout' })
  })

  it('times out in the hydration phase when the transcript never arrives', async () => {
    ensureSessionSlice('runtime-1', { runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })

    const wake = awaitSessionPainted('stored-1', { expectHistory: true, timeoutMs: 1_000 }).catch(
      (e: unknown) => e as SessionWakeError
    )

    await vi.advanceTimersByTimeAsync(1_100)
    expect(await wake).toMatchObject({ phase: 'hydration', reason: 'timeout' })
  })

  it('reports a superseded wake when the caller aborts', async () => {
    const controller = new AbortController()

    const wake = awaitSessionPainted('stored-1', { signal: controller.signal }).catch(
      (e: unknown) => e as SessionWakeError
    )

    controller.abort()
    expect(await wake).toMatchObject({ phase: 'activation', reason: 'superseded' })
  })

  it('refuses a blank id rather than waiting on a session that cannot exist', async () => {
    await expect(awaitSessionPainted(null)).rejects.toBeInstanceOf(SessionWakeError)
  })
})
