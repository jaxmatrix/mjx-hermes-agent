// Regression: the backend's session-search FTS layer wraps matched terms in
// literal '>>>' / '<<<' snippet() delimiters (hermes_state_search.py). The
// sidebar paints the snippet as plain text — for BOTH the row title and the
// preview in universal — so an unstripped marker renders rows reading
// ">>>foo<<<". Ported from desktop 20059cbc69.
import { describe, expect, it } from 'vitest'

import { stripFtsMarkers } from './strip-fts-markers'

describe('stripFtsMarkers', () => {
  it('strips highlight markers around the matched term', () => {
    expect(stripFtsMarkers('...replied with >>>MARCO<<< and nothing else...')).toBe(
      '...replied with MARCO and nothing else...'
    )
  })

  it('strips multiple marked terms', () => {
    expect(stripFtsMarkers('>>>alpha<<< then >>>beta<<<')).toBe('alpha then beta')
  })

  it('leaves marker-free snippets untouched', () => {
    expect(stripFtsMarkers('plain snippet text')).toBe('plain snippet text')
  })

  it('handles empty string', () => {
    expect(stripFtsMarkers('')).toBe('')
  })
})
