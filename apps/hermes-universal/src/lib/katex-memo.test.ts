import type { Element, Root } from 'hast'
import katex from 'katex'
import { unified } from 'unified'
import { VFile } from 'vfile'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMemoizedMathPlugin, KATEX_HTML_TAG } from './katex-memo'

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

// The single collapsed node the plugin splices in, and the KaTeX HTML it holds.
const emitted = (tree: Root) => {
  const wrapper = tree.children[0] as Element
  const node = wrapper.children[0] as Element
  const first = node.children[0]

  return { html: first?.type === 'text' ? first.value : '', node }
}

// Count every node in the tree — the number this rewrite exists to hold down.
const nodeCount = (node: { children?: unknown[] }): number =>
  1 + ((node.children ?? []) as { children?: unknown[] }[]).reduce((sum, child) => sum + nodeCount(child), 0)

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

// Every hast node becomes a React element AND an inline-styled DOM node, and
// every later style recalc / layout pass walks all of them — which is what made
// resizing or toggling a sidebar stall on a math-heavy chat. So one equation
// must cost exactly one node, with KaTeX's markup carried as a string.
describe('collapsed output', () => {
  it('emits a single node per equation, holding the KaTeX markup as text', () => {
    const tree = render(String.raw`\zeta_{collapse}`)
    const { html: markup, node } = emitted(tree)

    expect(node.tagName).toBe(KATEX_HTML_TAG)
    expect(node.children).toHaveLength(1)
    expect(nodeCount(node)).toBe(2) // the element + its one text child
    expect(markup).toContain('class="katex"')
    // The ~65 spans KaTeX emits stay inside the string, out of the tree.
    expect(markup.split('<span').length - 1).toBeGreaterThan(5)
  })

  it('marks display mode on the node so layout and styling can key off it', () => {
    expect(emitted(render(String.raw`\eta_{inline}`, false)).node.properties?.dataDisplay).toBe('false')
    expect(emitted(render(String.raw`\eta_{block}`, true)).node.properties?.dataDisplay).toBe('true')
  })

  it('renders a ```math fence as display math, replacing the whole <pre>', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'pre',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'code',
              properties: { className: ['language-math'] },
              children: [{ type: 'text', value: String.raw`\theta_{fence}` }]
            }
          ]
        }
      ]
    }

    unified()
      .use(plugin.rehypePlugin as never)
      .runSync(tree, new VFile(''))

    const node = tree.children[0] as Element

    expect(node.tagName).toBe(KATEX_HTML_TAG)
    expect(node.properties?.dataDisplay).toBe('true')
  })

  it('still reports broken TeX on the file and renders a lenient fallback', () => {
    const file = new VFile('')
    const tree = mathTree(String.raw`\frac{`)

    unified()
      .use(plugin.rehypePlugin as never)
      .runSync(tree, file)

    expect(file.messages).toHaveLength(1)
    expect(file.messages[0].source).toBe('rehype-katex-memo')

    const { html: markup, node } = emitted(tree)

    expect(node.tagName).toBe(KATEX_HTML_TAG)
    expect(markup).toContain('katex')
  })

  it('escapes the source in the last-resort fallback so it cannot inject markup', () => {
    // Force both KaTeX passes to fail so the hand-built fallback branch runs.
    vi.spyOn(katex, 'renderToString').mockImplementation(() => {
      throw new Error('boom')
    })

    const tree = mathTree('<img src=x onerror=alert(1)>')

    unified()
      .use(plugin.rehypePlugin as never)
      .runSync(tree, new VFile(''))

    const { html: markup } = emitted(tree)

    expect(markup).toContain('katex-error')
    expect(markup).not.toContain('<img')
    expect(markup).toContain('&lt;img')
  })
})
