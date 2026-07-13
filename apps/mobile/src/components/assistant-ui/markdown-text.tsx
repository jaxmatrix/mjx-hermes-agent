import { StreamdownTextPrimitive } from '@assistant-ui/react-streamdown'

import { cn } from '@/lib/utils'

// The Text-part renderer. streamdown handles streaming-safe markdown + GFM +
// built-in Shiki code highlighting; we key the prose colors to the A2 tokens so
// it works in dark/light without prose's own gray palette. Rendered inside the
// assistant-ui part context (reads the part text itself).
//
// FIXME(G): add @streamdown/math for KaTeX; FIXME(R11): open links externally
// via tauri-plugin-opener; FIXME(G7): media / generated-image embeds.
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
  return <StreamdownTextPrimitive className={MARKDOWN_CLASS} />
}
