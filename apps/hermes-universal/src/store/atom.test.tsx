import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { atom, computed, useStore } from './atom'

describe('store engine (real nanostores)', () => {
  it('get/set/subscribe', () => {
    const $n = atom(1)
    const seen: number[] = []
    const unsub = $n.subscribe(v => seen.push(v))
    $n.set(2)
    $n.set(2) // no-op on unchanged value
    $n.set(3)
    unsub()
    $n.set(4)
    expect($n.get()).toBe(4)
    expect(seen).toEqual([1, 2, 3]) // immediate + each change, no duplicate, none after unsub
  })

  it('computed derives and updates from a source atom', () => {
    const $base = atom(2)
    const $double = computed($base, n => n * 2)
    const unsub = $double.subscribe(() => {})
    expect($double.get()).toBe(4)
    $base.set(5)
    expect($double.get()).toBe(10)
    unsub()
  })

  it('useStore re-renders a component on set', () => {
    const $count = atom(0)

    function View() {
      const count = useStore($count)

      return <span>count:{count}</span>
    }

    render(<View />)
    expect(screen.getByText('count:0')).toBeInTheDocument()
    act(() => $count.set(7))
    expect(screen.getByText('count:7')).toBeInTheDocument()
  })
})
