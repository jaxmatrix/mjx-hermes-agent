#!/usr/bin/env node
/**
 * Markdown/KaTeX pipeline microbench — the node-side half of the perf harness.
 *
 * Measures the cost of turning one LaTeX-heavy assistant message into a hast
 * tree, split by stage, so a regression in the pipeline is catchable without
 * launching the webview. The webview-side cost (DOM construction, style recalc,
 * layout on a width change) is measured by bench/index.html instead — this file
 * deliberately does not model it.
 *
 * The headline number is NODE COUNT, not milliseconds: every hast node becomes
 * a React element AND an inline-styled DOM node, and it's the node count that
 * every later style/layout pass has to walk.
 *
 *   node apps/hermes-universal/bench/pipeline-bench.mjs
 *   node apps/hermes-universal/bench/pipeline-bench.mjs --json
 *
 * Exits non-zero if the collapsed pipeline regresses past MAX_NODES — wire that
 * into CI once phase 1 lands.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import katex from 'katex'
import { Lexer } from 'marked'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'

const FIXTURE = fileURLToPath(new URL('../src/dev/fixtures/latex-heavy.md', import.meta.url))
const ITERATIONS = 20

// Ceiling for the collapsed (one-node-per-equation) pipeline at x1. Baseline
// before phase 1 is ~5.8k nodes for a comparable fixture; after collapse the
// tree should be within a few percent of the no-math tree.
const MAX_NODES = 1500

const source = readFileSync(FIXTURE, 'utf8')

function timed(label, fn) {
  fn()

  const start = process.hrtime.bigint()

  for (let i = 0; i < ITERATIONS; i += 1) {
    fn()
  }

  const ms = Number(process.hrtime.bigint() - start) / 1e6 / ITERATIONS

  return { label, ms }
}

function countNodes(tree) {
  let count = 0
  const walk = node => {
    count += 1

    for (const child of node.children ?? []) {
      walk(child)
    }
  }

  walk(tree)

  return count
}

/**
 * Stand-in for lib/katex-memo's CURRENT strategy: render, re-parse the HTML
 * back into hast, splice the whole subtree in.
 */
function rehypeKatexExpanded() {
  return tree => {
    visitMath(tree, (parent, index, scope, displayMode, value) => {
      const html = katex.renderToString(value, { displayMode, throwOnError: false })

      parent.children.splice(index, 1, ...fromHtmlIsomorphic(html, { fragment: true }).children)
    })
  }
}

/**
 * Stand-in for lib/katex-memo's TARGET strategy: render to a string, splice in
 * exactly one node carrying that string.
 */
function rehypeKatexCollapsed() {
  return tree => {
    visitMath(tree, (parent, index, scope, displayMode, value) => {
      const html = katex.renderToString(value, { displayMode, throwOnError: false })

      parent.children.splice(index, 1, {
        type: 'element',
        tagName: 'katex-html',
        properties: { dataDisplay: displayMode ? 'true' : 'false' },
        children: [{ type: 'text', value: html }]
      })
    })
  }
}

// Minimal re-implementation of the katex-memo visitor, kept dependency-free so
// the bench doesn't drift when the real plugin is rewritten.
function visitMath(tree, onMath) {
  const walk = (node, parent) => {
    const children = node.children ?? []

    for (let i = 0; i < children.length; i += 1) {
      walk(children[i], node)
    }

    if (node.type !== 'element' || !parent) {
      return
    }

    const classes = Array.isArray(node.properties?.className) ? node.properties.className : []
    const languageMath = classes.includes('language-math')
    const mathDisplay = classes.includes('math-display')
    const mathInline = classes.includes('math-inline')

    if (!(languageMath || mathDisplay || mathInline)) {
      return
    }

    const index = parent.children.indexOf(node)

    if (index === -1) {
      return
    }

    const value = textOf(node)

    onMath(parent, index, node, mathDisplay || languageMath, value)
  }

  walk(tree, null)
}

function textOf(node) {
  if (node.type === 'text') {
    return node.value
  }

  return (node.children ?? []).map(textOf).join('')
}

function pipeline(katexPlugin) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: true })
    .use(remarkRehype, { allowDangerousHtml: true })

  if (katexPlugin) {
    processor.use(katexPlugin)
  }

  return () => processor.runSync(processor.parse(source), source)
}

const runNoMath = pipeline(null)
const runExpanded = pipeline(rehypeKatexExpanded)
const runCollapsed = pipeline(rehypeKatexCollapsed)

const results = [
  timed('marked lex (block split)', () => Lexer.lex(source, { gfm: true })),
  timed('unified → hast, no math render', runNoMath),
  timed('unified → hast, expanded KaTeX (before)', runExpanded),
  timed('unified → hast, collapsed KaTeX (after)', runCollapsed)
]

const nodesNoMath = countNodes(runNoMath())
const nodesExpanded = countNodes(runExpanded())
const nodesCollapsed = countNodes(runCollapsed())

const mathCount = (source.match(/\$/g) ?? []).length / 2

const report = {
  fixtureChars: source.length,
  approxMathSpans: Math.round(mathCount),
  timings: Object.fromEntries(results.map(r => [r.label, Number(r.ms.toFixed(2))])),
  nodes: { noMath: nodesNoMath, expanded: nodesExpanded, collapsed: nodesCollapsed },
  inflation: {
    expanded: Number((nodesExpanded / nodesNoMath).toFixed(1)),
    collapsed: Number((nodesCollapsed / nodesNoMath).toFixed(1))
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(
    `fixture: ${report.fixtureChars} chars, ~${report.approxMathSpans} math spans, ${ITERATIONS} iterations\n`
  )

  for (const { label, ms } of results) {
    console.log(`  ${label.padEnd(42)} ${ms.toFixed(2).padStart(8)} ms`)
  }

  console.log('')
  console.log(`  hast nodes, no math render                 ${String(nodesNoMath).padStart(8)}`)
  console.log(
    `  hast nodes, expanded KaTeX (before)        ${String(nodesExpanded).padStart(8)}  (${report.inflation.expanded}x)`
  )
  console.log(
    `  hast nodes, collapsed KaTeX (after)        ${String(nodesCollapsed).padStart(8)}  (${report.inflation.collapsed}x)`
  )
}

if (nodesCollapsed > MAX_NODES) {
  console.error(`\nFAIL: collapsed pipeline emits ${nodesCollapsed} nodes, over the ${MAX_NODES} ceiling.`)
  process.exit(1)
}
