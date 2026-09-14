import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $composerSuggestionsBySession,
  clearDraftSuggestions,
  type ComposerSuggestion,
  markSuggestionInvoked,
  offerSuggestions,
  registerDraftProvider,
  sampleComposerDraft,
  suggestionKey
} from '@/store/composer-suggestions'

/**
 * The composer suggestion bus. Four of the five hardening commits behind the
 * MCP pills live HERE rather than in the matcher — the cap, the dedupe, the
 * declined ledger and the rendered-field change gate — so this is where they
 * have to be pinned.
 */

const suggestion = (id: string, over: Partial<ComposerSuggestion> = {}): ComposerSuggestion => ({
  doneLabel: `Added ${id}`,
  doneTip: 'done',
  id,
  invoke: vi.fn().mockResolvedValue(undefined),
  label: `Add ${id}`,
  provider: 'mcp',
  tip: 'because',
  workingLabel: `Connecting ${id}…`,
  workingTip: 'cancel',
  ...over
})

const shown = (key: string) => ($composerSuggestionsBySession.get()[key] ?? []).map(suggestionKey)

let unregister: (() => void) | null = null

// The bus keeps its event offerings, draft offerings and declined ledger in
// module-level maps keyed by session — there is deliberately no reset (a
// session key IS the isolation unit at runtime), so every test takes a fresh
// pair of keys rather than leaking a previous test's offers or strikes.
let seq = 0
let key = ''
let other = ''

beforeEach(() => {
  unregister?.()
  unregister = null
  $composerSuggestionsBySession.set({})
  seq += 1
  key = `s-${seq}-a`
  other = `s-${seq}-b`
})

describe('the suggestion cap and dedupe', () => {
  it('publishes at most two, however many are offered', () => {
    offerSuggestions(key, 'mcp', [suggestion('a'), suggestion('b'), suggestion('c')])

    expect(shown(key)).toEqual(['mcp:a', 'mcp:b'])
  })

  it('never publishes one key twice', () => {
    offerSuggestions(key, 'mcp', [suggestion('a')])
    offerSuggestions(key, 'skill', [suggestion('a')])

    expect(shown(key)).toEqual(['mcp:a'])
  })

  it('namespaces keys by provider, so two providers can share an id', () => {
    offerSuggestions(key, 'mcp', [suggestion('linear')])
    offerSuggestions(key, 'skill', [suggestion('linear', { provider: 'skill' })])

    expect(shown(key)).toEqual(['mcp:linear', 'skill:linear'])
  })

  it('keeps each session to its own suggestions', () => {
    offerSuggestions(key, 'mcp', [suggestion('a')])
    offerSuggestions(other, 'mcp', [suggestion('b')])

    expect(shown(key)).toEqual(['mcp:a'])
    expect(shown(other)).toEqual(['mcp:b'])
  })
})

describe('the change gate', () => {
  it('keeps the array reference when nothing rendered changed', () => {
    offerSuggestions(key, 'mcp', [suggestion('a')])
    const first = $composerSuggestionsBySession.get()[key]

    offerSuggestions(key, 'mcp', [suggestion('a')])

    expect($composerSuggestionsBySession.get()[key]).toBe(first)
  })

  // Key equality is TRUE constantly (a provider rebuilds its objects on every
  // sample), so comparing keys alone pinned the first object forever — a stale
  // tip and, worse, a stale `invoke` closure. Same key, changed copy: the write
  // has to land, and the NEW invoke has to be the one that runs.
  it('lets a genuinely changed offer through, closure and all', async () => {
    offerSuggestions(key, 'mcp', [suggestion('a', { tip: 'because you said jira' })])
    const first = $composerSuggestionsBySession.get()[key]

    const freshInvoke = vi.fn().mockResolvedValue(undefined)

    offerSuggestions(key, 'mcp', [suggestion('a', { invoke: freshInvoke, tip: 'because you pasted a link' })])

    expect($composerSuggestionsBySession.get()[key]).not.toBe(first)
    expect($composerSuggestionsBySession.get()[key]?.[0]?.tip).toBe('because you pasted a link')

    await $composerSuggestionsBySession.get()[key]![0]!.invoke({ cancelled: () => false, sessionId: key })
    expect(freshInvoke).toHaveBeenCalled()
  })
})

describe('the declined ledger', () => {
  const flicker = (session: string, times: number) => {
    for (let i = 0; i < times; i += 1) {
      offerSuggestions(session, 'mcp', [suggestion('linear')])
      offerSuggestions(session, 'mcp', [])
    }
  }

  // A pill the user watched appear and let die three times is a declined offer.
  it('stops publishing a suggestion withdrawn uninvoked three times', () => {
    flicker(key, 3)
    offerSuggestions(key, 'mcp', [suggestion('linear')])

    expect(shown(key)).toEqual([])
  })

  it('still publishes it after only two', () => {
    flicker(key, 2)
    offerSuggestions(key, 'mcp', [suggestion('linear')])

    expect(shown(key)).toEqual(['mcp:linear'])
  })

  // Acting on a pill is the opposite of ignoring it — its later withdrawal is
  // success, not a strike.
  it('forgives the count once the suggestion is invoked', () => {
    flicker(key, 2)
    offerSuggestions(key, 'mcp', [suggestion('linear')])
    markSuggestionInvoked(key, 'mcp:linear')
    offerSuggestions(key, 'mcp', [])
    flicker(key, 2)
    offerSuggestions(key, 'mcp', [suggestion('linear')])

    expect(shown(key)).toEqual(['mcp:linear'])
  })

  // A fresh chat is a fresh chance.
  it('is scoped to one session', () => {
    flicker(key, 3)
    offerSuggestions(other, 'mcp', [suggestion('linear')])

    expect(shown(other)).toEqual(['mcp:linear'])
  })
})

describe('the debounced draft sampler', () => {
  const provider = vi.fn()

  beforeEach(() => {
    provider.mockReset()
    provider.mockResolvedValue([suggestion('linear')])
    unregister = registerDraftProvider('test', provider)
  })

  it('runs the provider once per settled draft, not per keystroke', async () => {
    vi.useFakeTimers()
    sampleComposerDraft(key, 'check li')
    sampleComposerDraft(key, 'check lin')
    sampleComposerDraft(key, 'check linear ')
    await vi.advanceTimersByTimeAsync(700)
    vi.useRealTimers()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider).toHaveBeenCalledWith({ sessionId: key, text: 'check linear ' })
    expect(shown(key)).toEqual(['mcp:linear'])
  })

  // Too short to mean anything — and it must not cost a provider round trip.
  it('clears without running the provider for a draft under three characters', async () => {
    offerSuggestions(key, 'other', [])
    vi.useFakeTimers()
    sampleComposerDraft(key, 'hi')
    await vi.advanceTimersByTimeAsync(700)
    vi.useRealTimers()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(provider).not.toHaveBeenCalled()
    expect(shown(key)).toEqual([])
  })

  // Two composers settle independently; a tile's sampling must not cancel the
  // primary's timer.
  it('debounces per session', async () => {
    vi.useFakeTimers()
    sampleComposerDraft(key, 'check linear ')
    sampleComposerDraft(other, 'check figma ')
    await vi.advanceTimersByTimeAsync(700)
    vi.useRealTimers()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(provider).toHaveBeenCalledTimes(2)
    expect(shown(key)).toEqual(['mcp:linear'])
    expect(shown(other)).toEqual(['mcp:linear'])
  })

  // A slow provider that resolves after a newer sample would otherwise paint
  // the previous draft's pills over the current draft's.
  it('discards a result a newer sample superseded', async () => {
    let releaseStale: (value: ComposerSuggestion[]) => void = () => {}

    provider.mockImplementationOnce(() => new Promise(resolve => (releaseStale = resolve)))
    provider.mockResolvedValueOnce([suggestion('figma')])

    vi.useFakeTimers()
    sampleComposerDraft(key, 'check linear ')
    await vi.advanceTimersByTimeAsync(700)
    sampleComposerDraft(key, 'check figma ')
    await vi.advanceTimersByTimeAsync(700)
    vi.useRealTimers()
    await new Promise(resolve => setTimeout(resolve, 0))

    releaseStale([suggestion('linear')])
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(shown(key)).toEqual(['mcp:figma'])
  })

  // A leaving session's "Add Linear" must not linger in the map and reappear
  // stale on the way back.
  it('withdraws a session draft offerings, and its pending timer, on leave', async () => {
    vi.useFakeTimers()
    sampleComposerDraft(key, 'check linear ')
    await vi.advanceTimersByTimeAsync(700)
    vi.useRealTimers()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(shown(key)).toEqual(['mcp:linear'])

    vi.useFakeTimers()
    sampleComposerDraft(key, 'check figma ')
    clearDraftSuggestions(key)
    await vi.advanceTimersByTimeAsync(700)
    vi.useRealTimers()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(shown(key)).toEqual([])
    expect(provider).toHaveBeenCalledTimes(1)
  })

  // A provider that throws must not take the strip down with it.
  it('survives a provider that rejects', async () => {
    provider.mockRejectedValue(new Error('catalog offline'))

    vi.useFakeTimers()
    sampleComposerDraft(key, 'check linear ')
    await vi.advanceTimersByTimeAsync(700)
    vi.useRealTimers()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(shown(key)).toEqual([])
  })
})
