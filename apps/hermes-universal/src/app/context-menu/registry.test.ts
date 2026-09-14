/**
 * The target registry's two load-bearing guarantees: ascending order decides,
 * and one kind owns one slot.
 *
 * Order is not cosmetic. `terminal` sits at 10 because xterm mirrors its canvas
 * selection into a real hidden `<textarea>`, so a `dom`-first registry would
 * call every terminal right-click "an editable" and offer edit verbs against a
 * scratch buffer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ContextGesture, ContextTargetProvider } from './registry'
import { __resetContextTargets, classifyGesture, contextTargetProvider, registerContextTarget } from './registry'

const GESTURE: ContextGesture = { element: null, source: 'mouse', x: 0, y: 0 }

function provider(kind: string, order: number, classify: () => unknown): ContextTargetProvider<unknown> {
  return { classify, items: () => [], kind, order }
}

afterEach(() => {
  __resetContextTargets()
})

describe('classifyGesture', () => {
  it('takes the first match by ASCENDING order, whatever the registration order', () => {
    registerContextTarget(provider('dom', 100, () => ({ from: 'dom' })))
    registerContextTarget(provider('terminal', 10, () => ({ from: 'terminal' })))

    expect(classifyGesture(GESTURE)).toEqual({ data: { from: 'terminal' }, kind: 'terminal' })
  })

  it('falls through a classifier that passes', () => {
    registerContextTarget(provider('terminal', 10, () => null))
    registerContextTarget(provider('dom', 100, () => ({ from: 'dom' })))

    expect(classifyGesture(GESTURE)?.kind).toBe('dom')
  })

  it('skips a classifier that throws, reports its kind, and lets the next one win', () => {
    const failed: string[] = []

    registerContextTarget(
      provider('broken', 20, () => {
        throw new Error('plugin is wrong')
      })
    )
    registerContextTarget(provider('dom', 100, () => ({ from: 'dom' })))

    expect(classifyGesture(GESTURE, kind => failed.push(kind))?.kind).toBe('dom')
    expect(failed).toEqual(['broken'])
  })

  it('returns null when nothing claims the gesture', () => {
    expect(classifyGesture(GESTURE)).toBeNull()
  })
})

describe('registerContextTarget', () => {
  it('replaces on re-registration — one slot per kind, never a listener set', () => {
    registerContextTarget(provider('dom', 100, () => ({ generation: 1 })))
    registerContextTarget(provider('dom', 100, () => ({ generation: 2 })))

    expect(classifyGesture(GESTURE)).toEqual({ data: { generation: 2 }, kind: 'dom' })
  })

  it('unregisters idempotently and never nulls a NEWER provider', () => {
    const release = registerContextTarget(provider('dom', 100, () => ({ generation: 1 })))

    registerContextTarget(provider('dom', 100, () => ({ generation: 2 })))
    release()
    release()

    expect(classifyGesture(GESTURE)).toEqual({ data: { generation: 2 }, kind: 'dom' })
  })

  it('hands the coordinator the provider that matched, so items come from the same one', () => {
    const items = vi.fn(() => [])

    registerContextTarget({ classify: () => ({}), items, kind: 'dom', order: 100 })

    expect(contextTargetProvider('dom')?.items).toBe(items)
    expect(contextTargetProvider('nothing')).toBeUndefined()
  })
})
