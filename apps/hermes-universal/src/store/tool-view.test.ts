import { beforeEach, describe, expect, it } from 'vitest'

import { $anyToolDisclosureOpen, $toolDisclosureOpen, $toolDisclosureStates, setToolDisclosureOpen } from './tool-view'

beforeEach(() => {
  $toolDisclosureStates.set({})
})

describe('$toolDisclosureOpen', () => {
  // Called bare in a render body — a fresh atom per render would make useStore
  // resubscribe every time.
  it('returns the SAME atom for an id so a render body can call it directly', () => {
    expect($toolDisclosureOpen('row-a')).toBe($toolDisclosureOpen('row-a'))
    expect($toolDisclosureOpen('row-a')).not.toBe($toolDisclosureOpen('row-b'))
  })

  it('reports undefined until the row is toggled, then its state', () => {
    const open = $toolDisclosureOpen('row-a')

    expect(open.get()).toBeUndefined()
    setToolDisclosureOpen('row-a', true)
    expect(open.get()).toBe(true)
    setToolDisclosureOpen('row-a', false)
    expect(open.get()).toBe(false)
  })
})

describe('$anyToolDisclosureOpen', () => {
  it('answers for the whole set — a live run asking whether one of its rows is open', () => {
    const anyOpen = $anyToolDisclosureOpen(['row-a', 'row-b'])

    expect(anyOpen.get()).toBe(false)
    setToolDisclosureOpen('row-b', true)
    expect(anyOpen.get()).toBe(true)
    setToolDisclosureOpen('row-b', false)
    expect(anyOpen.get()).toBe(false)
  })

  it('ignores rows outside its own set', () => {
    const anyOpen = $anyToolDisclosureOpen(['row-a'])

    setToolDisclosureOpen('row-elsewhere', true)
    expect(anyOpen.get()).toBe(false)
  })

  // Same atom for the same id set — a render body can call this bare, like
  // `$toolDisclosureOpen`. Desktop keeps the joined-id Map cache.
  it('returns the SAME atom for an id list so a render body can call it directly', () => {
    expect($anyToolDisclosureOpen(['row-a'])).toBe($anyToolDisclosureOpen(['row-a']))
    expect($anyToolDisclosureOpen(['row-a'])).not.toBe($anyToolDisclosureOpen(['row-b']))
  })
})
