import { describe, expect, it } from 'vitest'

import { detectTrigger } from './text-utils'

// Ported from apps/desktop/src/app/chat/composer/text-utils.test.ts (the
// clipboard-image extraction cases are dropped — image paste is deferred here).
describe('detectTrigger', () => {
  it('detects a bare slash trigger with an empty query', () => {
    expect(detectTrigger('/')).toEqual({ kind: '/', query: '', tokenLength: 1 })
  })

  it('detects a slash command query', () => {
    expect(detectTrigger('/skill')).toEqual({ kind: '/', query: 'skill', tokenLength: 6 })
  })

  it('detects a bare at-mention trigger with an empty query', () => {
    expect(detectTrigger('@')).toEqual({ kind: '@', query: '', tokenLength: 1 })
  })

  it('detects an at-mention query', () => {
    expect(detectTrigger('@file')).toEqual({ kind: '@', query: 'file', tokenLength: 5 })
  })

  it('returns null for plain text', () => {
    expect(detectTrigger('hello there')).toBeNull()
  })

  it('keeps the slash trigger live while typing args', () => {
    expect(detectTrigger('/personality ')).toEqual({ kind: '/', query: 'personality ', tokenLength: 13 })
    expect(detectTrigger('/personality alic')).toEqual({ kind: '/', query: 'personality alic', tokenLength: 17 })
  })

  it('anchors slash strictly at the start of the line (never mid-message)', () => {
    expect(detectTrigger('hello /world')).toBeNull()
  })

  it('detects an at-mention after whitespace mid-line', () => {
    expect(detectTrigger('see @src')).toEqual({ kind: '@', query: 'src', tokenLength: 4 })
  })
})
