import { describe, expect, it } from 'vitest'

import { takeSpeechChunk } from './speech-chunker'

describe('takeSpeechChunk', () => {
  it('takes a leading sentence once it is long enough', () => {
    expect(takeSpeechChunk('Hi there. More coming')).toEqual({
      chunk: 'Hi there.',
      rest: 'More coming'
    })
  })

  it('holds a too-short leading sentence until forced', () => {
    // "Hi." is under the 8-char minimum → nothing yet.
    expect(takeSpeechChunk('Hi. and then')).toEqual({ chunk: null, rest: 'Hi. and then' })
    // Forcing flushes the whole buffer.
    expect(takeSpeechChunk('Hi. and then', true)).toEqual({ chunk: 'Hi.', rest: 'and then' })
  })

  it('matches CJK sentence punctuation (needs a trailing boundary, like the original)', () => {
    // The sentence regex requires whitespace-or-end after the terminal — so with a
    // space it chunks, and without one it waits (verbatim from the ported logic).
    expect(takeSpeechChunk('こんにちは、世界。 次の文')).toEqual({
      chunk: 'こんにちは、世界。',
      rest: '次の文'
    })
    expect(takeSpeechChunk('こんにちは、世界。次の文')).toEqual({
      chunk: null,
      rest: 'こんにちは、世界。次の文'
    })
  })

  it('splits a long boundary-less buffer at a soft boundary', () => {
    const long = `${'a'.repeat(120)}, ${'b'.repeat(120)}`
    const { chunk, rest } = takeSpeechChunk(long)
    // Soft boundary is the last ", " before index 180 (well past index 80).
    expect(chunk?.endsWith(',')).toBe(true)
    expect(chunk?.startsWith('a')).toBe(true)
    expect(rest.startsWith('b')).toBe(true)
  })

  it('takes nothing from a short boundary-less buffer without force', () => {
    expect(takeSpeechChunk('just some words with no end')).toEqual({
      chunk: null,
      rest: 'just some words with no end'
    })
  })

  it('flushes the whole buffer when forced', () => {
    expect(takeSpeechChunk('no terminal punctuation here', true)).toEqual({
      chunk: 'no terminal punctuation here',
      rest: ''
    })
  })

  it('collapses whitespace and trims', () => {
    expect(takeSpeechChunk('  Hello   world.  next ')).toEqual({
      chunk: 'Hello world.',
      rest: 'next'
    })
  })

  it('returns empty for a blank buffer', () => {
    expect(takeSpeechChunk('   ')).toEqual({ chunk: null, rest: '' })
  })
})
