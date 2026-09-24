import { render, waitFor } from '@testing-library/react'
import type { Element } from 'hast'
import { memo } from 'react'
import { Streamdown } from 'streamdown'
import { describe, expect, it } from 'vitest'

import { createMemoizedMathPlugin, KATEX_HTML_TAG } from '@/lib/katex-memo'
import { normalizeFilePreviewMath } from '@/lib/markdown-preprocess'

const KatexHtml = memo(function KatexHtml({ node }: { node?: Element }) {
  const first = node?.children?.[0]
  const html = first && first.type === 'text' ? first.value : ''
  const display = node?.properties?.dataDisplay === 'true'

  return (
    <span className="katex-host" dangerouslySetInnerHTML={{ __html: html }} data-display={display ? 'true' : 'false'} />
  )
})

// This is the exact pipeline the file preview runs: normalizeFilePreviewMath
// → Streamdown with the memoized math plugin. Rendering here (jsdom) proves the
// wiring produces KaTeX output, not raw `$..$` source text.
describe('file-preview math rendering', () => {
  const mathPlugin = createMemoizedMathPlugin({ singleDollarTextMath: true })
  const components = { [KATEX_HTML_TAG]: KatexHtml }

  it('renders inline $..$ math as KaTeX', async () => {
    const { container } = render(
      <Streamdown components={components} mode="static" plugins={{ math: mathPlugin }}>
        {normalizeFilePreviewMath('The formula $x^2 + y^2$ here.')}
      </Streamdown>
    )

    await waitFor(() => {
      expect(container.querySelector('.katex-host .katex')).not.toBeNull()
    })
    expect(container.textContent).not.toContain('$x^2')
  })

  it('renders $$..$$ display math as KaTeX', async () => {
    const { container } = render(
      <Streamdown components={components} mode="static" plugins={{ math: mathPlugin }}>
        {normalizeFilePreviewMath('Block:\n\n$$E = mc^2$$')}
      </Streamdown>
    )

    await waitFor(() => {
      expect(
        container.querySelector('.katex-host[data-display="true"] .katex') ||
          container.querySelector('.katex-host .katex')
      ).not.toBeNull()
    })
  })

  it('renders delimited math as KaTeX', async () => {
    const { container } = render(
      <Streamdown components={components} mode="static" plugins={{ math: mathPlugin }}>
        {normalizeFilePreviewMath('A fraction \\(\\frac{a}{b}\\) inline.')}
      </Streamdown>
    )

    await waitFor(() => {
      expect(container.querySelector('.katex-host .katex')).not.toBeNull()
    })
    expect(container.querySelector('.katex-mathml, .katex-html')).not.toBeNull()
  })

  it('leaves a literal code-fence $ alone as code, not math', async () => {
    const { container } = render(
      <Streamdown components={components} mode="static" plugins={{ math: mathPlugin }}>
        {normalizeFilePreviewMath('```bash\necho $HOME\n```')}
      </Streamdown>
    )

    await waitFor(() => {
      expect(container.querySelector('.katex-host')).toBeNull()
    })
    expect(container.querySelector('code')?.textContent).toContain('$HOME')
  })
})
