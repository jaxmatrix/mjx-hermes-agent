import { describe, expect, it } from 'vitest'

import { escapeCurrencyDollars, preprocessMarkdown, promoteStandaloneDisplayMath } from './markdown-preprocess'

// remark-math only classes `$$…$$` as display math when the delimiters sit on
// their own lines. Models emit the single-line form constantly, so without this
// promotion most standalone equations in a chat rendered as small in-flow math.
describe('promoteStandaloneDisplayMath', () => {
  it('promotes a paragraph that is only $$…$$', () => {
    expect(promoteStandaloneDisplayMath('a\n\n$$x + y$$\n\nb')).toBe('a\n\n$$\nx + y\n$$\n\nb')
  })

  it('promotes when the line is the whole input', () => {
    expect(promoteStandaloneDisplayMath('$$ECSA = \\frac{C_{dl}}{C_s}$$')).toBe(
      '$$\nECSA = \\frac{C_{dl}}{C_s}\n$$'
    )
  })

  it('tolerates up to three leading spaces (markdown paragraph indent)', () => {
    expect(promoteStandaloneDisplayMath('   $$x$$')).toBe('$$\nx\n$$')
  })

  // Everything below must stay untouched — promoting any of these would change
  // the document's structure, not just how one equation is styled.
  it('leaves mid-sentence display math inline', () => {
    const text = 'the identity $$x$$ holds'

    expect(promoteStandaloneDisplayMath(text)).toBe(text)
  })

  it('leaves a $$…$$ line that is part of a paragraph', () => {
    const text = 'given that\n$$x$$\nwe conclude'

    expect(promoteStandaloneDisplayMath(text)).toBe(text)
  })

  it('leaves list items and blockquotes alone', () => {
    expect(promoteStandaloneDisplayMath('- $$x$$')).toBe('- $$x$$')
    expect(promoteStandaloneDisplayMath('> $$x$$')).toBe('> $$x$$')
  })

  it('leaves an indented code block alone', () => {
    expect(promoteStandaloneDisplayMath('    $$x$$')).toBe('    $$x$$')
  })

  it('leaves a line holding more than one expression', () => {
    expect(promoteStandaloneDisplayMath('$$x$$ $$y$$')).toBe('$$x$$ $$y$$')
    expect(promoteStandaloneDisplayMath('$$$$')).toBe('$$$$')
  })

  it('leaves the already-correct multi-line form untouched', () => {
    const text = '$$\nx\n$$'

    expect(promoteStandaloneDisplayMath(text)).toBe(text)
  })
})

// Upstream escapes EVERY `$` before a digit, which mangles math that happens to
// open with one — a table row of `$5$–$50\,\Omega$` rendered as literal text.
describe('escapeCurrencyDollars', () => {
  it('still escapes prices', () => {
    expect(escapeCurrencyDollars('it costs $5 and $10.')).toBe('it costs \\$5 and \\$10.')
    expect(escapeCurrencyDollars('$1,299 total')).toBe('\\$1,299 total')
    expect(escapeCurrencyDollars('from $5 to $10')).toBe('from \\$5 to \\$10')
  })

  it('does not pair two prices in one sentence into fake math', () => {
    // Body `5 + ` has whitespace and no TeX-only character, so it reads as prose.
    expect(escapeCurrencyDollars('$5 + $10 = $15')).toBe('\\$5 + \\$10 = \\$15')
  })

  it('preserves digit-leading math that closes with no whitespace', () => {
    expect(escapeCurrencyDollars('$5$')).toBe('$5$')
    expect(escapeCurrencyDollars('range $0.8$–$1.0$')).toBe('range $0.8$–$1.0$')
    expect(escapeCurrencyDollars('$10^2$')).toBe('$10^2$')
  })

  it('preserves digit-leading math containing TeX commands', () => {
    expect(escapeCurrencyDollars('$50\\,\\Omega$')).toBe('$50\\,\\Omega$')
    expect(escapeCurrencyDollars('$10^3\\,\\mu\\mathrm{F}$')).toBe('$10^3\\,\\mu\\mathrm{F}$')
  })

  it('leaves display math and already-escaped dollars alone', () => {
    expect(escapeCurrencyDollars('$$5x$$')).toBe('$$5x$$')
    expect(escapeCurrencyDollars('already \\$5')).toBe('already \\$5')
  })

  it('does not pair across a line break', () => {
    expect(escapeCurrencyDollars('costs $5\nand $6')).toBe('costs \\$5\nand \\$6')
  })
})

// The two fixes have to survive the full pipeline, not just their own unit.
describe('preprocessMarkdown', () => {
  it('promotes a standalone equation end to end', () => {
    expect(preprocessMarkdown('Given:\n\n$$ECSA = \\frac{C_{dl}}{C_s}$$\n\nSo.')).toContain(
      '$$\nECSA = \\frac{C_{dl}}{C_s}\n$$'
    )
  })

  it('keeps a table row of digit-leading math intact', () => {
    const row = '| $R_s$ | $5$–$50\\,\\Omega$ |'

    expect(preprocessMarkdown(row)).toBe(row)
  })

  it('still escapes prices in prose', () => {
    expect(preprocessMarkdown('The plan costs $20 per month.')).toContain('\\$20')
  })

  it('does not touch dollars inside a fenced code block', () => {
    const fence = '```bash\necho $5\n```'

    expect(preprocessMarkdown(fence)).toContain('echo $5')
  })
})
