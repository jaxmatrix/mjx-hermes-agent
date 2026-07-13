import { afterEach, describe, expect, it } from 'vitest'

import { Codecs, persistentAtom } from './persisted'

afterEach(() => localStorage.clear())

describe('persistentAtom', () => {
  it('seeds the fallback when nothing is stored', () => {
    const $a = persistentAtom('k.bool', true, Codecs.bool)
    expect($a.get()).toBe(true)
  })

  it('seeds from a stored value when present', () => {
    localStorage.setItem('k.bool', 'false')
    const $a = persistentAtom('k.bool', true, Codecs.bool)
    expect($a.get()).toBe(false)
  })

  it('writes back to storage on change', () => {
    const $a = persistentAtom('k.text', '', Codecs.text)
    $a.set('hello')
    expect(localStorage.getItem('k.text')).toBe('hello')
  })

  it('falls back (no throw) on a corrupt stored value', () => {
    localStorage.setItem('k.json', '{not json')
    const $a = persistentAtom('k.json', { ok: true }, Codecs.json<{ ok: boolean }>())
    expect($a.get()).toEqual({ ok: true })
  })

  it('removes the key when stringArray encodes to empty', () => {
    const $a = persistentAtom('k.arr', ['x'], Codecs.stringArray)
    expect(localStorage.getItem('k.arr')).toBe('["x"]')
    $a.set([])
    expect(localStorage.getItem('k.arr')).toBeNull()
  })

  it('round-trips stringArray, dropping non-strings/empties on decode', () => {
    localStorage.setItem('k.arr2', JSON.stringify(['a', '', 'b']))
    const $a = persistentAtom<string[]>('k.arr2', [], Codecs.stringArray)
    expect($a.get()).toEqual(['a', 'b'])
  })
})
