import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import {
  __resetTranscriptTailCache,
  __TAIL_CACHE_BOUNDS,
  aliasTranscriptTail,
  clearTranscriptTails,
  dropTranscriptTails,
  readTranscriptTail,
  saveTranscriptTail,
  transcriptTailCacheStatus
} from '@/lib/transcript-tail-cache'

const { MAX_ENTRIES, MAX_ENTRY_BYTES, STORAGE_PREFIX, TAIL_MESSAGES } = __TAIL_CACHE_BOUNDS

const key = (id: string) => `${STORAGE_PREFIX}${id}`

const text = (id: string, body: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({
  id,
  parts: [{ text: body, type: 'text' }],
  role
})

const longTranscript = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, i) => text(`m${i}`, `line ${i}`, i % 2 === 0 ? 'user' : 'assistant'))

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  __resetTranscriptTailCache()
})

describe('saveTranscriptTail / readTranscriptTail', () => {
  // T1 / A3 — the runtime id is minted fresh by every resume, so an entry keyed
  // on one is unreadable exactly when it matters.
  it('round-trips a tail keyed by the STORED id, and misses on the runtime id', () => {
    expect(saveTranscriptTail('stored-1', [text('m1', 'hello')])).toBe('saved')

    expect(readTranscriptTail('stored-1')?.map(m => m.id)).toEqual(['m1'])
    expect(readTranscriptTail('runtime-9')).toBeNull()
    expect(localStorage.getItem(key('stored-1'))).toContain('"storedSessionId":"stored-1"')
  })

  // T2
  it('persists only the bounded tail of a long transcript', () => {
    saveTranscriptTail('stored-1', longTranscript(TAIL_MESSAGES + 25))

    const cached = readTranscriptTail('stored-1')

    expect(cached).toHaveLength(TAIL_MESSAGES)
    expect(cached?.[0].id).toBe(`m${25}`)
    expect(cached?.at(-1)?.id).toBe(`m${TAIL_MESSAGES + 24}`)
  })

  // T3 — never split a message: the fallback drops whole rows.
  it('falls back to an 8-message tail rather than caching an oversized entry', () => {
    const huge = 'x'.repeat(MAX_ENTRY_BYTES / 4)
    const messages = longTranscript(20).map((m, i) => (i < 12 ? text(m.id, huge) : m))

    expect(saveTranscriptTail('stored-1', messages)).toBe('saved')

    const cached = readTranscriptTail('stored-1')

    expect(cached).toHaveLength(__TAIL_CACHE_BOUNDS.FALLBACK_TAIL_MESSAGES)
    expect(cached?.every(m => m.parts.length === 1)).toBe(true)
  })

  it('reports too-large when even the fallback tail will not fit', () => {
    const huge = 'y'.repeat(MAX_ENTRY_BYTES)

    expect(saveTranscriptTail('stored-1', [text('m1', huge)])).toBe('too-large')
    expect(readTranscriptTail('stored-1')).toBeNull()
  })

  // T4
  it('ignores empty saves and blank ids', () => {
    expect(saveTranscriptTail('stored-1', [])).toBe('skipped-empty')
    expect(saveTranscriptTail('  ', [text('m1', 'hi')])).toBe('skipped-empty')
    expect(saveTranscriptTail(null, [text('m1', 'hi')])).toBe('skipped-empty')
    expect(localStorage.length).toBe(0)
  })

  // T10 / I4 — the sanitiser is the defence in depth behind the paint lane.
  it('refuses every live-tail row shape and seals open tool parts', () => {
    saveTranscriptTail('stored-1', [
      text('committed', 'settled turn'),
      { ...text('pending-flag', 'streaming', 'assistant'), pending: true },
      text('assistant-stream-1', 'streaming', 'assistant'),
      text('inflight-assistant-1', 'streaming', 'assistant'),
      text('user-inflight-1', 'optimistic'),
      text('user-queued-1', 'queued'),
      {
        id: 'tool-row',
        parts: [{ toolCallId: 't1', toolName: 'terminal', type: 'tool-call' }],
        role: 'assistant'
      }
    ])

    const cached = readTranscriptTail('stored-1')

    expect(cached?.map(m => m.id)).toEqual(['committed', 'tool-row'])
    // A tool call with no result renders as a spinner nothing will resolve.
    expect(cached?.[1].parts[0]).toMatchObject({ result: {} })
  })

  it('drops the live-turn flag and the re-fetched reactions', () => {
    saveTranscriptTail('stored-1', [{ ...text('m1', 'hi'), reactions: [{ at: 1, author: 'user', emoji: '👍' }] }])

    const cached = readTranscriptTail('stored-1')

    expect(cached?.[0]).not.toHaveProperty('reactions')
    expect(cached?.[0]).not.toHaveProperty('pending')
  })

  it('skips a save it cannot serialize instead of throwing on the settle path', () => {
    const circular = { text: '', type: 'text' } as { text: string; type: 'text' }

    ;(circular as unknown as { self: unknown }).self = circular

    expect(saveTranscriptTail('stored-1', [{ id: 'm1', parts: [circular], role: 'user' }])).toBe('skipped-empty')
  })
})

describe('corruption', () => {
  // T5
  it('self-evicts a corrupt entry instead of returning garbage', () => {
    localStorage.setItem(key('stored-1'), '{"kind":"tail","messa')

    expect(readTranscriptTail('stored-1')).toBeNull()
    expect(localStorage.getItem(key('stored-1'))).toBeNull()
    expect(transcriptTailCacheStatus().lastFailure).toBe('corrupt')
  })

  // T6 / A2 — the MJXHRM-495 shape. `lib/persisted.ts` writes its FALLBACK back
  // over a blob that failed to decode, erasing every sibling; separate keys make
  // that impossible here.
  it('leaves the siblings of a corrupt entry readable', () => {
    saveTranscriptTail('stored-1', [text('m1', 'one')])
    saveTranscriptTail('stored-2', [text('m2', 'two')])
    localStorage.setItem(key('stored-1'), 'not json at all')

    expect(readTranscriptTail('stored-1')).toBeNull()
    expect(readTranscriptTail('stored-2')?.map(m => m.id)).toEqual(['m2'])
  })

  it('treats an entry filed under the wrong id as corrupt', () => {
    saveTranscriptTail('stored-1', [text('m1', 'one')])
    localStorage.setItem(key('stored-2'), localStorage.getItem(key('stored-1')) as string)

    expect(readTranscriptTail('stored-2')).toBeNull()
    expect(readTranscriptTail('stored-1')?.map(m => m.id)).toEqual(['m1'])
  })

  // T7 — the index is a HINT. A corrupt one costs an LRU ordering, never data.
  it('rebuilds a corrupt index from the keyspace and deletes nothing', () => {
    saveTranscriptTail('stored-1', [text('m1', 'one')])
    saveTranscriptTail('stored-2', [text('m2', 'two')])
    localStorage.setItem('hermes.universal.transcriptTail.v1-index', '{{{ truncated')

    // A fresh window: the next touch of the cache runs the once-per-window
    // housekeeping, which is the pass that reads the index.
    __resetTranscriptTailCache()
    saveTranscriptTail('stored-3', [text('m3', 'three')])

    expect(readTranscriptTail('stored-1')?.map(m => m.id)).toEqual(['m1'])
    expect(readTranscriptTail('stored-2')?.map(m => m.id)).toEqual(['m2'])
    expect(readTranscriptTail('stored-3')?.map(m => m.id)).toEqual(['m3'])
    expect(transcriptTailCacheStatus().entries).toBe(3)
    expect(localStorage.getItem('hermes.universal.transcriptTail.v1-index')).toContain('"stored-2"')
  })
})

describe('bounds', () => {
  // T8
  it('evicts past MAX_ENTRIES, oldest first', () => {
    let clock = 1_000

    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000))

    for (let i = 0; i < MAX_ENTRIES + 3; i += 1) {
      saveTranscriptTail(`stored-${i}`, [text(`m${i}`, `body ${i}`)])
    }

    expect(transcriptTailCacheStatus().entries).toBe(MAX_ENTRIES)
    expect(readTranscriptTail('stored-0')).toBeNull()
    expect(readTranscriptTail(`stored-${MAX_ENTRIES + 2}`)).not.toBeNull()
  })

  it('evicts past MAX_TOTAL_BYTES even when the count cap is not reached', () => {
    let clock = 1_000

    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000))

    // 13 entries just under the PER-ENTRY cap: the count cap (16) is never in
    // play, so only the byte budget can evict the oldest.
    const body = 'z'.repeat(MAX_ENTRY_BYTES - 512)
    const count = 13

    for (let i = 0; i < count; i += 1) {
      expect(saveTranscriptTail(`stored-${i}`, [text(`m${i}`, body)])).toBe('saved')
    }

    expect(transcriptTailCacheStatus().entries).toBeLessThan(count)
    expect(transcriptTailCacheStatus().bytes).toBeLessThanOrEqual(__TAIL_CACHE_BOUNDS.MAX_TOTAL_BYTES)
    expect(readTranscriptTail('stored-0')).toBeNull()
    expect(readTranscriptTail(`stored-${count - 1}`)).not.toBeNull()
  })

  it('refuses an entry older than the TTL on the read, before any sweep has run', () => {
    saveTranscriptTail('stored-1', [text('m1', 'one')])

    const aged = JSON.parse(localStorage.getItem(key('stored-1')) as string) as { savedAt: number }

    aged.savedAt = Date.now() - __TAIL_CACHE_BOUNDS.MAX_AGE_MS - 1
    localStorage.setItem(key('stored-1'), JSON.stringify(aged))
    // A fresh window whose FIRST touch is the boot paint — no save, so no sweep.
    __resetTranscriptTailCache()

    expect(readTranscriptTail('stored-1')).toBeNull()
    expect(localStorage.getItem(key('stored-1'))).toBeNull()
  })

  it('sweeps an entry older than the TTL on the next housekeeping', () => {
    saveTranscriptTail('stored-1', [text('m1', 'one')])

    const stale = JSON.parse(localStorage.getItem(key('stored-1')) as string) as { savedAt: number }

    stale.savedAt = Date.now() - __TAIL_CACHE_BOUNDS.MAX_AGE_MS - 1
    localStorage.setItem(key('stored-1'), JSON.stringify(stale))
    __resetTranscriptTailCache()

    // The first touch of a new window runs the sweep.
    saveTranscriptTail('stored-2', [text('m2', 'two')])
    expect(readTranscriptTail('stored-1')).toBeNull()
    expect(readTranscriptTail('stored-2')).not.toBeNull()
  })

  // T11 — a small cache beats a stale one; a second failure is reported, never
  // retried in a loop, because typing must never be affected by quota.
  it('clears and retries once on quota, then reports it', () => {
    saveTranscriptTail('stored-old', [text('m0', 'old')])

    // Swap the STORE rather than spying a method: the module reads
    // `window.localStorage` on every call, and whether that resolves to jsdom's
    // proxy-backed Storage or the test-setup shim differs by Node version.
    const real = window.localStorage
    let budget = 1

    const failing = {
      clear: () => real.clear(),
      getItem: (k: string) => real.getItem(k),
      key: (i: number) => real.key(i),
      get length() {
        return real.length
      },
      removeItem: (k: string) => real.removeItem(k),
      setItem: (k: string, v: string) => {
        if (budget > 0) {
          budget -= 1

          throw new DOMException('quota', 'QuotaExceededError')
        }

        real.setItem(k, v)
      }
    } as Storage

    const useStore = (store: Storage) =>
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => store })

    useStore(failing)

    expect(saveTranscriptTail('stored-new', [text('m1', 'new')])).toBe('saved')
    // The clear-and-retry threw the rest of the keyspace away, deliberately:
    // a small cache beats a stale one.
    expect(readTranscriptTail('stored-old')).toBeNull()
    expect(readTranscriptTail('stored-new')?.map(m => m.id)).toEqual(['m1'])

    // A second failure is REPORTED, never retried in a loop — a synchronous
    // stall against a full quota is worse than no paint, and typing must never
    // be affected by it.
    budget = Number.MAX_SAFE_INTEGER

    expect(saveTranscriptTail('stored-2', [text('m2', 'two')])).toBe('quota')
    expect(transcriptTailCacheStatus().lastFailure).toBe('quota')

    useStore(real)
  })
})

describe('aliases, drops and the wipe', () => {
  // T12
  it('resolves an alias pointer in one hop and never chains', () => {
    saveTranscriptTail('stored-live', [text('m1', 'one')])
    aliasTranscriptTail('stored-rotated', 'stored-live')

    expect(readTranscriptTail('stored-rotated')?.map(m => m.id)).toEqual(['m1'])

    // A pointer to a pointer is a mis-write, not a chain to walk.
    aliasTranscriptTail('stored-older', 'stored-rotated')
    expect(readTranscriptTail('stored-older')).toBeNull()
  })

  // T9
  it('drops every alias of a deleted conversation, and wipes everything on a re-home', () => {
    saveTranscriptTail('stored-live', [text('m1', 'one')])
    aliasTranscriptTail('stored-rotated', 'stored-live')
    saveTranscriptTail('stored-other', [text('m2', 'two')])

    dropTranscriptTails(['stored-live', 'stored-rotated', null, undefined])
    expect(readTranscriptTail('stored-live')).toBeNull()
    expect(readTranscriptTail('stored-rotated')).toBeNull()
    expect(readTranscriptTail('stored-other')?.map(m => m.id)).toEqual(['m2'])

    clearTranscriptTails()
    expect(readTranscriptTail('stored-other')).toBeNull()
    expect(transcriptTailCacheStatus().entries).toBe(0)
  })

  it('leaves keys outside its own prefix alone when it wipes', () => {
    localStorage.setItem('hermes.activeProfile', '"work"')
    saveTranscriptTail('stored-1', [text('m1', 'one')])

    clearTranscriptTails()

    expect(localStorage.getItem('hermes.activeProfile')).toBe('"work"')
  })
})

// T13 — every window of this origin shares these keys, so a write next door must
// not be masked by this window's own view of them.
describe('cross-window', () => {
  it('invalidates the id mirror on a storage event under the prefix', () => {
    saveTranscriptTail('stored-1', [text('m1', 'one')])

    // Another window's write, which never went through this module.
    localStorage.setItem(
      key('stored-2'),
      JSON.stringify({
        bytes: 10,
        kind: 'tail',
        messages: [text('m2', 'two')],
        savedAt: Date.now(),
        storedSessionId: 'stored-2',
        v: 1
      })
    )
    window.dispatchEvent(new StorageEvent('storage', { key: key('stored-2') }))

    expect(readTranscriptTail('stored-2')?.map(m => m.id)).toEqual(['m2'])
    expect(transcriptTailCacheStatus().entries).toBe(2)
  })
})

describe('transcriptTailCacheStatus', () => {
  it('reports an unavailable store rather than pretending it is empty', () => {
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked origin')
    })

    expect(saveTranscriptTail('stored-1', [text('m1', 'one')])).toBe('unavailable')
    expect(transcriptTailCacheStatus()).toMatchObject({ available: false, lastFailure: 'unavailable' })
    spy.mockRestore()
  })
})
