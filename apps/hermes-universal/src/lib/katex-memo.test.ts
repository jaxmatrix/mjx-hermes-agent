import type { Root } from 'hast'
import katex from 'katex'
import { unified } from 'unified'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VFile } from 'vfile'

import { createMemoizedMathPlugin } from './katex-memo'

// Build the hast shape remark-math emits for `$x$` / `$$x$$`, so the plugin is
// exercised through the same input rehype-katex would see.
const mathTree = (value: string, display = false): Root => ({
  type: 'root',
  children: [
    {
      type: 'element',
      tagName: 'span',
      properties: {},
      children: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: [display ? 'math-display' : 'math-inline'] },
          children: [{ type: 'text', value }]
        }
      ]
    }
  ]
})

const plugin = createMemoizedMathPlugin({ singleDollarTextMath: true })

const render = (value: string, display = false): Root => {
  const tree = mathTree(value, display)
  const transform = unified().use(plugin.rehypePlugin as never)

  transform.runSync(tree, new VFile(''))

  return tree
}

const html = (tree: Root): string => JSON.stringify(tree)

afterEach(() => vi.restoreAllMocks())

// The stock @streamdown/math plugin re-runs KaTeX over every equation on every
// markdown commit — every streaming token and every remount. This wrapper keys
// them on (displayMode, source) in a process-global LRU.
describe('createMemoizedMathPlugin', () => {
  it('renders the same markup on a cache hit without calling KaTeX again', () => {
    const expression = String.raw`\alpha_{memo} + \beta^{2}`
    const first = render(expression)

    const spy = vi.spyOn(katex, 'renderToString')
    const second = render(expression)

    expect(spy).not.toHaveBeenCalled()
    expect(html(second)).toBe(html(first))
    // Real KaTeX output, not a passthrough of the source node.
    expect(html(first)).toContain('katex')
  })

  it('re-renders when the expression changes', () => {
    render(String.raw`\gamma_{one}`)

    const spy = vi.spyOn(katex, 'renderToString')
    render(String.raw`\gamma_{two}`)

    expect(spy).toHaveBeenCalledOnce()
  })

  it('keys display and inline renders separately', () => {
    const expression = String.raw`\delta_{shared}`
    render(expression, false)

    const spy = vi.spyOn(katex, 'renderToString')
    render(expression, true)

    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0][1]).toMatchObject({ displayMode: true })
  })

  it('hands each render its own nodes so a consumer cannot poison the cache', () => {
    const expression = String.raw`\epsilon_{clone}`
    const first = render(expression)
    const second = render(expression)

    expect(first.children[0]).not.toBe(second.children[0])
    expect(html(second)).toBe(html(first))
  })
})
