import { describe, expect, it } from 'vitest'

import {
  escapeCurrencyDollars,
  preprocessMarkdown,
  promoteStandaloneDisplayMath,
  splitHuggingDisplayMath
} from './markdown-preprocess'

// remark-math only classes `$$…$$` as display math when the delimiters sit on
// their own lines. Models emit the single-line form constantly, so without this
// promotion most standalone equations in a chat rendered as small in-flow math.
describe('promoteStandaloneDisplayMath', () => {
  it('promotes a paragraph that is only $$…$$', () => {
    expect(promoteStandaloneDisplayMath('a\n\n$$x + y$$\n\nb')).toBe('a\n\n$$\nx + y\n$$\n\nb')
  })

  it('promotes when the line is the whole input', () => {
    expect(promoteStandaloneDisplayMath('$$ECSA = \\frac{C_{dl}}{C_s}$$')).toBe('$$\nECSA = \\frac{C_{dl}}{C_s}\n$$')
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

// CITATION_MARKER_RE's lookbehind accepts any letter, so the `t` of `\sqrt`
// qualifies and `[3]` is stripped as a citation marker — before KaTeX ever sees
// it. Numeric-only, which is why `\sqrt[n]{8}` survived and made this look like
// a KaTeX layout edge case rather than a preprocessing one.
describe('math spans shielded from the prose rewrites', () => {
  it('keeps a numeric radical index inside inline math', () => {
    expect(preprocessMarkdown('The value $\\sqrt[3]{8}$ is two.')).toContain('\\sqrt[3]{8}')
  })

  it('keeps a numeric radical index inside display math', () => {
    expect(preprocessMarkdown('$$\n\\sqrt[3]{8}\n$$')).toContain('\\sqrt[3]{8}')
  })

  it('keeps the index when an escaped dollar sits inside the same span', () => {
    // The inline body has to step OVER `\$` rather than treat it as the closing
    // delimiter, or the span never matches and the shield silently lapses.
    expect(preprocessMarkdown('$\\sqrt[3]{8} + \\$5$')).toContain('\\sqrt[3]{8}')
  })

  it('still strips a real citation marker in prose next to math', () => {
    // The shield must not become a blanket amnesty: prose either side of the
    // span keeps its rewrites.
    const out = preprocessMarkdown('As shown[3], $\\sqrt[3]{8}$ is two[4].')

    expect(out).toContain('\\sqrt[3]{8}')
    expect(out).not.toContain('shown[3]')
    expect(out).not.toContain('two[4]')
  })

  it('does not mistake a prose run opening with a stray dollar for math', () => {
    // Odd-index-is-a-delimiter, not startsWith('$'): a lone dollar leaves the
    // whole remainder as prose, so the citation marker after it still strips.
    expect(preprocessMarkdown('Costs \\$5 and cited[3] here.')).not.toContain('cited[3]')
  })
})

// remark-math's flow-math construct is fence-shaped: text after the opening `$$`
// on the same line is read as an info string and DISCARDED, and the closing `$$`
// is only recognised alone on its own line. So the hugging form never closes and
// KaTeX paints the remains as raw error text.
describe('splitHuggingDisplayMath', () => {
  it('moves hugging delimiters onto their own lines', () => {
    expect(splitHuggingDisplayMath('$$\\begin{aligned}\na &= b\n\\end{aligned}$$')).toBe(
      '$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$'
    )
  })

  it('leaves a single-line $$…$$ alone', () => {
    // That form routes through the inline math-text construct and already
    // renders; promoteStandaloneDisplayMath owns it.
    expect(splitHuggingDisplayMath('$$x^2$$')).toBe('$$x^2$$')
  })

  it('replays the container prefix onto both delimiter lines', () => {
    expect(splitHuggingDisplayMath('> $$\\begin{aligned}\n> a &= b\n> \\end{aligned}$$')).toBe(
      '> $$\n> \\begin{aligned}\n> a &= b\n> \\end{aligned}\n> $$'
    )
  })

  it('leaves an unclosed opener untouched', () => {
    expect(splitHuggingDisplayMath('$$\\begin{aligned}\na &= b')).toBe('$$\\begin{aligned}\na &= b')
  })

  it('reaches the hugging form normalizeMathDelimiters itself produces', () => {
    // A multi-line `\[…\]` comes out of that rewrite as
    // `$$\begin{aligned}…\end{aligned}$$` — users who never typed a `$$` hit
    // the same bug, which is why the split runs after it in the pipeline.
    const out = preprocessMarkdown('\\[\n\\begin{aligned}\na &= b\n\\end{aligned}\n\\]')

    expect(out).toContain('$$\n\\begin{aligned}')
    expect(out).toContain('\\end{aligned}\n$$')
  })
})
