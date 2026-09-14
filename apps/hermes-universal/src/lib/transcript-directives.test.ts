import { describe, expect, it } from 'vitest'

import { isSettledDirective, parseTranscriptDirective } from './transcript-directives'

describe('parseTranscriptDirective', () => {
  it('parses a bare directive with no attributes', () => {
    expect(parseTranscriptDirective('::tasks')).toEqual({ name: 'tasks', attrs: {}, source: '::tasks' })
  })

  it('parses double-quoted attributes', () => {
    expect(parseTranscriptDirective('::preview{file="demo.html"}')).toEqual({
      name: 'preview',
      attrs: { file: 'demo.html' },
      source: '::preview{file="demo.html"}'
    })
  })

  it('parses multiple attributes and accepts single quotes', () => {
    expect(parseTranscriptDirective(`::vis{file="a b.html" height='480'}`)?.attrs).toEqual({
      file: 'a b.html',
      height: '480'
    })
  })

  it('lowercases attribute keys but preserves values', () => {
    expect(parseTranscriptDirective('::vis{File="A.html"}')?.attrs).toEqual({ file: 'A.html' })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseTranscriptDirective('  ::tasks{id="1"}  ')?.name).toBe('tasks')
  })

  it('rejects prose containing a directive mid-text', () => {
    expect(parseTranscriptDirective('see ::preview{file="x.html"} above')).toBeNull()
  })

  it('rejects multi-line paragraphs', () => {
    expect(parseTranscriptDirective('::preview{file="x.html"}\nmore')).toBeNull()
  })

  it('rejects C++ scope-resolution lookalikes', () => {
    expect(parseTranscriptDirective('::std')).toEqual({ name: 'std', attrs: {}, source: '::std' })
    expect(parseTranscriptDirective('std::vector<int>')).toBeNull()
    expect(parseTranscriptDirective('::Vector')).toBeNull()
  })

  it('rejects unquoted attribute values', () => {
    expect(parseTranscriptDirective('::preview{file=demo.html}')?.attrs).toEqual({})
  })

  it('bounds pathological input instead of scanning it', () => {
    expect(parseTranscriptDirective(`::x{${'a="b" '.repeat(400)}}`)).toBeNull()
  })

  // The streaming contract, which is the reason the closed brace is mandatory
  // rather than merely tidy: the transcript re-parses the same paragraph on
  // every token, so EVERY prefix of a directive has to be a non-directive or
  // a half-typed `::preview{fi` flashes a card built from attributes the model
  // has not finished writing.
  describe('streaming partials', () => {
    const complete = '::preview{file="index.html" height="480"}'

    it('never yields a partially-filled attribute set for any prefix', () => {
      const withAttrs = []

      // Start past `::` — a bare `::` is not a directive either, but the
      // interesting boundary is inside the attribute block.
      for (let end = 2; end < complete.length; end += 1) {
        const parsed = parseTranscriptDirective(complete.slice(0, end))

        if (parsed && Object.keys(parsed.attrs).length > 0) {
          withAttrs.push({ prefix: complete.slice(0, end), attrs: parsed.attrs })
        }
      }

      // Not "no prefix parses" — every prefix of the NAME (`::p`, `::pr`, …
      // `::preview`) is itself a legal bare directive. The invariant that
      // matters is that no prefix ever produces attributes: a consumer can
      // never be handed `{ file: "ind" }` and render half a card.
      expect(withAttrs).toEqual([])
    })

    it('flags a brace-less prefix as unsettled so a name-prefix claim cannot flash', () => {
      // `::pre` is a real prefix of `::preview{…}` mid-stream. If a plugin
      // claimed `pre`, rendering it here would put ITS card inside someone
      // else's directive for a few tokens.
      const pre = parseTranscriptDirective('::pre')!

      expect(isSettledDirective(pre, true)).toBe(false)
      expect(isSettledDirective(pre, false)).toBe(true)
    })

    it('lets a braced directive render live — the brace makes it unambiguous', () => {
      const braced = parseTranscriptDirective(complete)!

      expect(isSettledDirective(braced, true)).toBe(true)
    })

    it('treats a bare braced directive as settled too (`::tasks{}`)', () => {
      expect(isSettledDirective(parseTranscriptDirective('::tasks{}')!, true)).toBe(true)
    })

    it('rejects a token boundary inside the attribute block', () => {
      expect(parseTranscriptDirective('::preview{fi')).toBeNull()
      expect(parseTranscriptDirective('::preview{file="ind')).toBeNull()
      expect(parseTranscriptDirective('::preview{file="index.html"')).toBeNull()
    })

    it('parses the whole thing the moment the brace closes', () => {
      expect(parseTranscriptDirective(complete)?.attrs).toEqual({ file: 'index.html', height: '480' })
    })
  })
})
