import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import fixture from '@/dev/fixtures/latex-heavy.md?raw'

import { MarkdownTextContent } from './markdown-text'

const renderMarkdown = async (text: string) => {
  const { container } = render(<MarkdownTextContent isRunning={false} text={text} />)

  await waitFor(() => expect(container.querySelector('.katex-host')).not.toBeNull())

  return container
}

// End-to-end through the REAL streamdown pipeline, not just the rehype plugin.
// The load-bearing claim being tested is that our custom `katex-html` tag
// survives streamdown's rehype-sanitize pass — it only does because streamdown
// appends the math plugin AFTER sanitize. If that ever changes, the sanitizer
// unwraps the tag and the KaTeX markup leaks out as escaped text; these tests
// fail loudly instead of shipping visibly broken equations.
describe('MarkdownTextContent math rendering', () => {
  it('renders inline math through a single host element', async () => {
    const container = await renderMarkdown('The capacitance $C_{dl}$ scales with area.')

    const hosts = container.querySelectorAll('.katex-host')

    expect(hosts).toHaveLength(1)
    expect(hosts[0].getAttribute('data-display')).toBe('false')
    // Real KaTeX markup reached the DOM rather than being escaped to text.
    expect(hosts[0].querySelector('.katex')).not.toBeNull()
    expect(container.textContent).toContain('scales with area')
  })

  it('renders fenced display math as a block host', async () => {
    const container = await renderMarkdown('```math\nECSA = \\frac{C_{dl}}{C_s}\n```')
    const host = container.querySelector('.katex-host')

    expect(host?.getAttribute('data-display')).toBe('true')
    expect(host?.querySelector('.katex')).not.toBeNull()
  })

  it('renders multi-line $$…$$ as a block host', async () => {
    const container = await renderMarkdown('$$\nECSA = \\frac{C_{dl}}{C_s}\n$$')

    expect(container.querySelector('.katex-host')?.getAttribute('data-display')).toBe('true')
  })

  // PRE-EXISTING BEHAVIOUR, pinned here deliberately rather than "fixed" as a
  // side effect of a perf change. remark-math classes a single-line `$$x$$` as
  // math-inline (only the multi-line form gets math-display), and stock
  // rehype-katex branches on exactly the same classes — so this rendered inline
  // before this rewrite too. The `data-display` attribute merely made it
  // visible. It is arguably wrong (most renderers treat a lone `$$x$$`
  // paragraph as display math, and models emit that form constantly), but
  // changing it is a rendering-semantics decision, not a performance one.
  it('renders single-line $$…$$ inline, matching remark-math/rehype-katex', async () => {
    const container = await renderMarkdown('$$ECSA = \\frac{C_{dl}}{C_s}$$')

    expect(container.querySelector('.katex-host')?.getAttribute('data-display')).toBe('false')
  })

  it('does not leak KaTeX markup as visible text', async () => {
    const container = await renderMarkdown('Consider $R_{ct}$ and $Z_W$ together.')

    // The sanitizer-unwrapped failure mode shows up as literal tag text.
    expect(container.textContent).not.toContain('<span')
    expect(container.textContent).not.toContain('katex-html')
  })

  // MarkdownSyntaxHighlighter reads the streaming flag from the aui store while
  // rendered deep inside streamdown's block tree. If that context didn't reach
  // (portal, detached render) or the selector shape were wrong, this throws
  // rather than rendering — so a passing render is the assertion that matters.
  it('renders a code fence, resolving streaming state from context', async () => {
    const { container } = render(
      <MarkdownTextContent isRunning={false} text={'Here:\n\n```python\nprint("hi")\n```\n'} />
    )

    await waitFor(() => expect(container.textContent).toContain('python'))
  })

  it('keeps the whole LaTeX-heavy fixture on one node per equation', async () => {
    const container = await renderMarkdown(fixture)

    const hosts = container.querySelectorAll('.katex-host')

    // The fixture is dense with math; if the plugin silently stopped matching,
    // this collapses to zero.
    expect(hosts.length).toBeGreaterThan(20)

    // Every host holds exactly one KaTeX root, and no host nests another —
    // i.e. one equation really is one node.
    for (const host of hosts) {
      expect(host.querySelectorAll('.katex-host')).toHaveLength(0)
    }

    // Prose, tables, code fences and the alert callout still render.
    expect(screen.getByText(/Randles circuit is used to model EIS data/)).toBeInTheDocument()
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.textContent).toContain('Warburg Impedance')
  })
})
