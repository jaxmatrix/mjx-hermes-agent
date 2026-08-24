/**
 * I1-I5: a painted row is pixels, never knowledge. The guard is structural — the
 * rows are not in `$sessionStates` — so these tests assert the STRUCTURE, not a
 * flag someone has to remember to check.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import { __resetTranscriptTailCache, saveTranscriptTail } from '@/lib/transcript-tail-cache'
import { $messages, $paintedMessages, $paintedMessagesEmpty } from '@/store/chat'
import {
  $activeSessionKey,
  $sessionStates,
  ensureSessionSlice,
  hydratingKey,
  updateSession
} from '@/store/session-state-types'
import {
  $transcriptPaint,
  __resetTranscriptPaint,
  BOOT_PAINT_KEY,
  clearTranscriptPaint,
  paintCachedTail
} from '@/store/transcript-paint'

const row = (id: string, body: string): ChatMessage => ({ id, parts: [{ text: body, type: 'text' }], role: 'user' })

beforeEach(() => {
  localStorage.clear()
  __resetTranscriptTailCache()
  __resetTranscriptPaint()
  $sessionStates.set({})
  $activeSessionKey.set('draft:test')
})

describe('paintCachedTail', () => {
  it('paints a cached tail under the slice key', () => {
    saveTranscriptTail('stored-1', [row('m1', 'hello')])
    ensureSessionSlice(hydratingKey('stored-1'), { busy: true, storedSessionId: 'stored-1' })

    expect(paintCachedTail(hydratingKey('stored-1'), 'stored-1')).toBe(true)
    expect($transcriptPaint.get()[hydratingKey('stored-1')].messages.map(m => m.id)).toEqual(['m1'])
  })

  // I1 — the whole design. `reconcileLiveTail` pairs rows by role ordinal, the
  // crash journal writes `state.messages` for every busy slice, and the voice
  // cursor narrates them. A painted row must be unreachable from all three, and
  // it is because it is not in the map they read.
  it('never writes a row into $sessionStates', () => {
    saveTranscriptTail('stored-1', [row('m1', 'hello')])

    const key = hydratingKey('stored-1')

    ensureSessionSlice(key, { busy: true, storedSessionId: 'stored-1' })
    paintCachedTail(key, 'stored-1')

    expect($sessionStates.get()[key].messages).toEqual([])
    expect(Object.values($sessionStates.get()).flatMap(state => state.messages)).toEqual([])
  })

  // T15
  it('refuses a second paint for a live key', () => {
    saveTranscriptTail('stored-1', [row('m1', 'hello')])

    const key = hydratingKey('stored-1')

    expect(paintCachedTail(key, 'stored-1')).toBe(true)
    expect(paintCachedTail(key, 'stored-1')).toBe(false)
    expect(Object.keys($transcriptPaint.get())).toHaveLength(1)
  })

  // The warm paths (promote, reclaim, reconnect reconciliation) must paint
  // NOTHING: their transcript is already correct and richer than any cache, so a
  // paint there is a flicker on top of the right answer.
  it('refuses to paint over a slice that already has messages', () => {
    saveTranscriptTail('stored-1', [row('cached', 'stale')])
    ensureSessionSlice('runtime-1', { storedSessionId: 'stored-1' })
    updateSession('runtime-1', state => ({ ...state, messages: [row('live', 'fresh')] }))

    expect(paintCachedTail('runtime-1', 'stored-1')).toBe(false)
    expect($transcriptPaint.get()).toEqual({})
  })

  it('refuses a cache miss, a blank key and a blank id', () => {
    expect(paintCachedTail(hydratingKey('stored-nope'), 'stored-nope')).toBe(false)
    expect(paintCachedTail('', 'stored-1')).toBe(false)
    expect(paintCachedTail('k', null)).toBe(false)
  })
})

describe('clearTranscriptPaint', () => {
  // T16
  it('clears one key, is idempotent, and clears everything with no argument', () => {
    saveTranscriptTail('stored-1', [row('m1', 'one')])
    saveTranscriptTail('stored-2', [row('m2', 'two')])
    paintCachedTail(hydratingKey('stored-1'), 'stored-1')
    paintCachedTail(BOOT_PAINT_KEY, 'stored-2')

    clearTranscriptPaint(hydratingKey('stored-1'))
    clearTranscriptPaint(hydratingKey('stored-1'))
    expect(Object.keys($transcriptPaint.get())).toEqual([BOOT_PAINT_KEY])

    clearTranscriptPaint()
    expect($transcriptPaint.get()).toEqual({})
  })

  it('does not republish the atom when there is nothing to clear', () => {
    const before = $transcriptPaint.get()

    clearTranscriptPaint()
    clearTranscriptPaint('absent')

    expect($transcriptPaint.get()).toBe(before)
  })
})

describe('$paintedMessages', () => {
  // T17 / the performance budget the review must hold us to: a fresh `[]` here
  // would break nanostores' dedupe and re-render every transcript in the app on
  // every streamed token.
  it('returns the IDENTICAL array reference as $messages when the lane is empty', () => {
    ensureSessionSlice('runtime-1', { storedSessionId: 'stored-1' })
    updateSession('runtime-1', state => ({ ...state, messages: [row('live', 'fresh')] }))
    $activeSessionKey.set('runtime-1')

    expect($paintedMessages.get()).toBe($messages.get())

    $activeSessionKey.set('draft:test')
    expect($paintedMessages.get()).toBe($messages.get())
  })

  it('shows the paint only while the slice has no messages of its own', () => {
    saveTranscriptTail('stored-1', [row('cached', 'last screen')])

    const key = hydratingKey('stored-1')

    ensureSessionSlice(key, { busy: true, storedSessionId: 'stored-1' })
    $activeSessionKey.set(key)
    paintCachedTail(key, 'stored-1')

    expect($paintedMessages.get().map(m => m.id)).toEqual(['cached'])
    expect($paintedMessagesEmpty.get()).toBe(false)
    // …and the authoritative lane is still empty, so nothing downstream of
    // `$messages` can see the cached row.
    expect($messages.get()).toEqual([])

    // The REST transcript lands: the authoritative rows replace the paint
    // wholesale, in the same frame.
    updateSession(key, state => ({ ...state, messages: [row('rest-1', 'authoritative')] }))
    expect($paintedMessages.get().map(m => m.id)).toEqual(['rest-1'])
    expect($paintedMessages.get()).toBe($messages.get())
  })

  it('leaves a paint for another key invisible to the active surface', () => {
    saveTranscriptTail('stored-2', [row('other', 'someone else')])
    paintCachedTail(hydratingKey('stored-2'), 'stored-2')
    $activeSessionKey.set('draft:test')

    expect($paintedMessages.get()).toEqual([])
    expect($paintedMessagesEmpty.get()).toBe(true)
  })
})
