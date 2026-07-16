import { TextMessagePartProvider, useMessagePartText } from '@assistant-ui/react'
import {
  parseMarkdownIntoBlocks,
  type StreamdownTextComponents,
  StreamdownTextPrimitive,
  type SyntaxHighlighterProps,
  tailBoundedRemend
} from '@assistant-ui/react-streamdown'
import { code } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import { type ComponentProps, memo, useMemo } from 'react'

import { ExpandableBlock } from '@/components/chat/expandable-block'
import { chunkByLines, SyntaxHighlighter } from '@/components/chat/shiki-highlighter'
import { normalizeExternalUrl, openExternalLink, PrettyLink } from '@/lib/external-link'
import { preprocessMarkdown } from '@/lib/markdown-preprocess'
import { cn } from '@/lib/utils'

// Math rendering plugin (KaTeX). `singleDollarTextMath: true` enables `$x^2$`
// inline math (the de-facto LLM convention).
//
// FIXME(chat-port): desktop uses a memoized rehype-katex wrapper (lib/katex-memo)
// that re-renders only changed equations during streaming. That pulls in
// remark-math + hast utils for a streaming perf win with byte-identical output;
// deferred. The stock @streamdown/math plugin renders identically.
const mathPlugin = createMathPlugin({ singleDollarTextMath: true })

// Replaces Streamdown's `parseIncompleteMarkdown` (full-text remend per flush)
// with a tail-bounded repair over our own preprocessing. Module-scope so the
// prop identity is stable across renders.
function preprocessWithTailRepair(text: string): string {
  try {
    return tailBoundedRemend(preprocessMarkdown(text))
  } catch {
    return text
  }
}

// Memoized block splitter. Streamdown lexes the whole message on every REMOUNT
// (virtualizer scroll, session switch); a module-level LRU keyed on the exact
// source string removes those repeat parses (same input → same output).
const BLOCK_CACHE_MAX = 64
const BLOCK_CACHE_MIN_LENGTH = 1024
const blockCache = new Map<string, string[]>()

function parseMarkdownIntoBlocksCached(markdown: string): string[] {
  if (markdown.length < BLOCK_CACHE_MIN_LENGTH) {
    return parseMarkdownIntoBlocks(markdown)
  }

  const hit = blockCache.get(markdown)

  if (hit) {
    blockCache.delete(markdown)
    blockCache.set(markdown, hit)

    return hit
  }

  const blocks = parseMarkdownIntoBlocks(markdown)
  blockCache.set(markdown, blocks)

  if (blockCache.size > BLOCK_CACHE_MAX) {
    blockCache.delete(blockCache.keys().next().value as string)
  }

  return blocks
}

function childrenToText(children: unknown): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children).trim()
  }

  if (Array.isArray(children) && children.every(c => typeof c === 'string' || typeof c === 'number')) {
    return children.join('').trim()
  }

  return ''
}

// FIXME(chat-port): media attachments (image/audio/video hrefs) and preview /
// URL rich embeds are deferred to the preview/media phase — they need the
// gateway-media RPCs universal doesn't expose yet. For now every link routes
// through the system browser via PrettyLink / openExternalLink.
function MarkdownLink({ children, className, href, ...props }: ComponentProps<'a'>) {
  const target = href ? normalizeExternalUrl(href) : href

  if (!target || !/^https?:\/\//i.test(target)) {
    return (
      <a
        className={cn(
          'font-semibold text-foreground underline underline-offset-4 decoration-current/20 wrap-anywhere',
          className
        )}
        href={href}
        onClick={event => {
          if (href) {
            event.preventDefault()
            void openExternalLink(href)
          }
        }}
        rel="noopener noreferrer"
        target="_blank"
        {...props}
      >
        {children}
      </a>
    )
  }

  const text = childrenToText(children)
  const fallbackLabel = text && normalizeExternalUrl(text) !== target ? text : undefined

  return (
    <PrettyLink className={cn('wrap-anywhere', className)} fallbackLabel={fallbackLabel} href={target} {...props} />
  )
}

function MarkdownImage({ className, src, alt, ...props }: ComponentProps<'img'>) {
  // FIXME(chat-port): ZoomableImage (click-to-zoom) lands with the embeds phase.
  return (
    <img
      alt={alt}
      className={cn(
        'm-0 block h-auto w-auto max-h-(--image-preview-height) max-w-[min(100%,var(--image-preview-max-width))] rounded-lg object-contain',
        className
      )}
      src={src}
      {...props}
    />
  )
}

interface MarkdownTextSurfaceProps {
  containerClassName?: string
  containerProps?: ComponentProps<'div'>
  defer?: boolean
}

// Headings shrink to chat scale rather than the prose default (h1≈xl).
const HEADING_SIZES: Record<'h1' | 'h2' | 'h3' | 'h4', string> = {
  h1: 'text-[1rem] tracking-tight',
  h2: 'text-[0.9375rem] tracking-tight',
  h3: 'text-[0.875rem]',
  h4: 'text-[0.8125rem]'
}

const MARKDOWN_CONTAINER_CLASS_NAME = cn(
  'aui-md prose w-full max-w-none overflow-hidden text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground',
  'prose-p:leading-(--dt-line-height) prose-li:leading-(--dt-line-height)',
  'prose-headings:text-foreground prose-strong:text-foreground',
  'prose-a:break-words prose-p:[overflow-wrap:anywhere]',
  'prose-li:marker:text-muted-foreground/70',
  'prose-code:rounded-[0.25rem] prose-code:px-[0.1875rem] prose-code:py-px prose-code:font-mono prose-code:text-[0.9em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>*+*]:mt-(--paragraph-gap)'
)

const MAX_MARKDOWN_CHARS = 200_000

function HugeTextFallback({ containerClassName, text }: { containerClassName?: string; text: string }) {
  const chunks = useMemo(() => chunkByLines(text, 200), [text])

  return (
    <div
      className={cn(
        'aui-md w-full max-w-none overflow-hidden rounded-[0.625rem] border border-border font-mono text-[0.7rem] leading-relaxed text-foreground/90',
        containerClassName
      )}
    >
      <ExpandableBlock className="p-2">
        {chunks.map((chunk, index) => (
          <div
            className="[content-visibility:auto]"
            key={index}
            style={{ containIntrinsicSize: `auto ${chunk.lines * 16}px` }}
          >
            {chunk.text}
          </div>
        ))}
      </ExpandableBlock>
    </div>
  )
}

function MarkdownTextSurface({ containerClassName, containerProps, defer }: MarkdownTextSurfaceProps) {
  const { status, text } = useMessagePartText()
  const isStreaming = status.type === 'running'

  // Keep code parsing enabled while streaming so incomplete fences still render
  // as code cards. The Shiki pass is deferred by SyntaxHighlighter when streaming.
  const plugins = useMemo(() => ({ math: mathPlugin, code }), [])

  const components = useMemo(
    () =>
      ({
        h1: ({ className, ...props }: ComponentProps<'h1'>) => (
          <h1 className={cn('my-1 font-semibold', HEADING_SIZES.h1, className)} {...props} />
        ),
        h2: ({ className, ...props }: ComponentProps<'h2'>) => (
          <h2 className={cn('my-1 font-semibold', HEADING_SIZES.h2, className)} {...props} />
        ),
        h3: ({ className, ...props }: ComponentProps<'h3'>) => (
          <h3 className={cn('my-1 font-semibold', HEADING_SIZES.h3, className)} {...props} />
        ),
        h4: ({ className, ...props }: ComponentProps<'h4'>) => (
          <h4 className={cn('my-1 font-semibold', HEADING_SIZES.h4, className)} {...props} />
        ),
        // Vertical rhythm owned by styles.css (`--paragraph-gap`) — no `my-*` here.
        p: ({ className, ...props }: ComponentProps<'p'>) => (
          <p className={cn('wrap-anywhere leading-(--dt-line-height)', className)} {...props} />
        ),
        a: MarkdownLink,
        inlineCode: ({ className, ...props }: ComponentProps<'code'>) => (
          <code className={className} dir="ltr" {...props} />
        ),
        // `---` as quiet spacing, not a heavy full-width rule.
        hr: (_props: ComponentProps<'hr'>) => <div aria-hidden className="my-3" />,
        // FIXME(chat-port): GFM alert callouts (> [!NOTE] …) land with the embeds phase.
        blockquote: ({ children, className, ...props }: ComponentProps<'blockquote'>) => (
          <blockquote
            className={cn('border-s-2 border-border ps-3 text-muted-foreground italic', className)}
            dir="auto"
            {...props}
          >
            {children}
          </blockquote>
        ),
        ul: ({ className, ...props }: ComponentProps<'ul'>) => (
          <ul className={cn('my-1 gap-0', className)} dir="auto" {...props} />
        ),
        ol: ({ className, ...props }: ComponentProps<'ol'>) => (
          <ol className={cn('my-1 gap-0', className)} dir="auto" {...props} />
        ),
        li: ({ className, ...props }: ComponentProps<'li'>) => (
          <li className={cn('leading-(--dt-line-height)', className)} {...props} />
        ),
        table: ({ className, ...props }: ComponentProps<'table'>) => (
          <div className="aui-md-table my-2 max-w-full overflow-x-auto rounded-[0.375rem] border border-border">
            <table
              className={cn(
                'm-0 w-full min-w-[18rem] border-collapse text-[0.8125rem] [&_tr]:border-b [&_tr]:border-border last:[&_tr]:border-0',
                className
              )}
              {...props}
            />
          </div>
        ),
        thead: ({ className, ...props }: ComponentProps<'thead'>) => (
          <thead className={cn('m-0 bg-muted/35 text-muted-foreground', className)} {...props} />
        ),
        th: ({ className, ...props }: ComponentProps<'th'>) => (
          <th
            className={cn(
              'whitespace-nowrap px-2.5 py-1.5 text-left align-middle text-[0.75rem] font-medium text-muted-foreground',
              className
            )}
            {...props}
          />
        ),
        td: ({ className, ...props }: ComponentProps<'td'>) => (
          <td className={cn('px-2.5 py-1.5 align-top text-[0.8125rem] leading-snug', className)} {...props} />
        ),
        img: MarkdownImage,
        // FIXME(chat-port): ```mermaid / ```svg fences route to lazy embed
        // renderers in the embeds phase. For now every language falls back to
        // the Shiki-highlighted code block.
        SyntaxHighlighter: (props: SyntaxHighlighterProps) => <SyntaxHighlighter {...props} defer={isStreaming} />
      }) as StreamdownTextComponents,
    [isStreaming]
  )

  if (text.length > MAX_MARKDOWN_CHARS) {
    return <HugeTextFallback containerClassName={containerClassName} text={text} />
  }

  return (
    <StreamdownTextPrimitive
      components={components}
      containerClassName={cn(MARKDOWN_CONTAINER_CLASS_NAME, containerClassName)}
      containerProps={containerProps}
      defer={defer}
      lineNumbers={false}
      mode="streaming"
      parseIncompleteMarkdown={false}
      parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocksCached}
      plugins={plugins}
      preprocess={preprocessWithTailRepair}
    />
  )
}

interface MarkdownTextContentProps extends MarkdownTextSurfaceProps {
  isRunning: boolean
  text: string
}

// Reasoning-text variant (no smoothing — matches the answer's plain append).
export function MarkdownTextContent({ isRunning, text, ...surfaceProps }: MarkdownTextContentProps) {
  return (
    <TextMessagePartProvider isRunning={isRunning} text={text}>
      <MarkdownTextSurface defer {...surfaceProps} />
    </TextMessagePartProvider>
  )
}

const MarkdownTextImpl = () => {
  return <MarkdownTextSurface defer />
}

export const MarkdownText = memo(MarkdownTextImpl)
