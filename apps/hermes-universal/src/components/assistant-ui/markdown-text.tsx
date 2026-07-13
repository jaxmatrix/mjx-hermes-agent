import { StreamdownTextPrimitive, type StreamdownTextComponents } from '@assistant-ui/react-streamdown'
import { code } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import type { ComponentProps } from 'react'

import { openExternalLink } from '@/lib/external-link'
import { cn } from '@/lib/utils'

// The Text-part renderer. streamdown handles streaming-safe markdown + GFM +
// Shiki code highlighting (the `code` plugin) + KaTeX (`math`). We key the prose
// colors to the A2 tokens so it works in dark/light without prose's own gray
// palette. Rendered inside the assistant-ui part context (reads the part text).
//
// FIXME(G7): media / generated-image embeds.

// Passing a plugins object replaces streamdown's default set, so `code` must be
// re-supplied. singleDollarTextMath enables inline `$x^2$` (the LLM convention).
const math = createMathPlugin({ singleDollarTextMath: true })

// Route link taps through the system browser (Gc6) — a plain <a> would navigate
// the Tauri webview away from the app.
const MARKDOWN_COMPONENTS: StreamdownTextComponents = {
  a: ({ href, children, node: _node, ...rest }: ComponentProps<'a'> & { node?: unknown }) => (
    <a
      {...rest}
      href={href}
      onClick={e => {
        e.preventDefault()
        if (href) void openExternalLink(href)
      }}
      rel="noreferrer"
    >
      {children}
    </a>
  )
}
const MARKDOWN_CLASS = cn(
  'prose prose-sm max-w-none break-words',
  'text-foreground',
  'prose-headings:text-foreground prose-p:text-foreground prose-strong:text-foreground prose-li:text-foreground',
  'prose-a:text-primary prose-a:break-words',
  'prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none',
  'prose-pre:bg-muted prose-pre:text-foreground prose-pre:rounded-md',
  'prose-blockquote:text-muted-foreground prose-blockquote:border-border',
  'prose-hr:border-border prose-th:text-foreground prose-td:text-foreground'
)

export function MarkdownText() {
  return (
    <StreamdownTextPrimitive className={MARKDOWN_CLASS} components={MARKDOWN_COMPONENTS} plugins={{ code, math, mermaid }} />
  )
}
