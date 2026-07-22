import { beforeEach, describe, expect, it, vi } from 'vitest'

import { evictThumb, readThumb, THUMB_CACHE_MAX, writeThumb } from './thumb-cache'

describe('thumb-cache', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a data URI', () => {
    writeThumb('cat', 'data:image/png;base64,AAA')
    expect(readThumb('cat')).toBe('data:image/png;base64,AAA')
    expect(readThumb('dog')).toBeNull()
  })

  it('evicts the oldest entries past the cap', () => {
    for (let i = 0; i < THUMB_CACHE_MAX + 5; i += 1) {
      writeThumb(`pet-${i}`, `uri-${i}`)
    }

    expect(readThumb('pet-0')).toBeNull()
    expect(readThumb('pet-4')).toBeNull()
    expect(readThumb('pet-5')).toBe('uri-5')
    expect(readThumb(`pet-${THUMB_CACHE_MAX + 4}`)).toBe(`uri-${THUMB_CACHE_MAX + 4}`)
  })

  it('keeps a re-read entry from being evicted first', () => {
    for (let i = 0; i < THUMB_CACHE_MAX; i += 1) {
      writeThumb(`pet-${i}`, `uri-${i}`)
    }

    // Bump the oldest, then overflow by one — the next-oldest should go instead.
    expect(readThumb('pet-0')).toBe('uri-0')
    writeThumb('fresh', 'uri-fresh')

    expect(readThumb('pet-0')).toBe('uri-0')
    expect(readThumb('pet-1')).toBeNull()
  })

  it('survives a quota error without throwing', () => {
    writeThumb('old', 'uri-old')

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(() => writeThumb('cat', 'uri-cat')).not.toThrow()
    setItem.mockRestore()
    expect(readThumb('cat')).toBeNull()
  })

  it('evicts a single slug from both payload and index', () => {
    writeThumb('cat', 'uri-cat')
    writeThumb('dog', 'uri-dog')
    evictThumb('cat')

    expect(readThumb('cat')).toBeNull()
    expect(readThumb('dog')).toBe('uri-dog')
    expect(localStorage.getItem('hermes.pet.thumb.index')).toBe(JSON.stringify(['dog']))
  })
})
