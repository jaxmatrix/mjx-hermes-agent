import { memo } from 'react'

import { CompactMarkdown } from '@/components/chat/compact-markdown'
import type { ChatMessage } from '@/lib/chat-messages'
import { cn } from '@/lib/utils'

/**
 * A PICTURE of where you were: the cached tail of the last conversation,
 * rendered behind the connecting card so a relaunch shows the chat instead of a
 * spinner while the socket dials (MJXHRM-480).
 *
 * It cannot be interacted with, BY CONSTRUCTION, and that is what makes it safe
 * to show for a session with no runtime binding: `pointer-events: none`,
 * `aria-hidden`, no focusable node, no scroller, no composer. There is nothing
 * here to type into, so nothing here can create a session.
 *
 * Deliberately NOT the real thread:
 *
 *  - no assistant-ui runtime, no tool renderers, no action bar — mounting them
 *    is precisely the cost paint-first exists to avoid;
 *  - tool calls collapse to one muted line, because a live tool card in a static
 *    picture is a spinner that will never resolve;
 *  - reasoning parts are dropped entirely: a thinking block torn out of its turn
 *    reads as the model talking to itself.
 *
 * WebKitGTK is the primary desktop target and is not Chromium, so the surface is
 * plain flex plus a prefixed gradient mask — no hatch pattern, no `:empty::before`
 * and no trig CSS (all three render wrong there).
 */

const FADE = 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.35) 22%, rgba(0,0,0,1) 60%)'

function previewText(message: ChatMessage): string {
  return message.parts
    .filter(part => part.type === 'text')
    .map(part => ('text' in part ? part.text : ''))
    .join('\n')
    .trim()
}

function toolNames(message: ChatMessage): string[] {
  return message.parts.filter(part => part.type === 'tool-call').map(part => ('toolName' in part ? part.toolName : ''))
}

const PreviewRow = memo(function PreviewRow({ message }: { message: ChatMessage }) {
  const text = previewText(message)
  const tools = toolNames(message)

  if (!text && !tools.length) {
    return null
  }

  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-1', message.role === 'user' ? 'items-end' : 'items-start')}>
      {tools.length ? (
        <div className="flex flex-col gap-0.5 text-[0.6875rem] leading-5 text-muted-foreground/60">
          {tools.map((name, index) => (
            <span key={`${name}-${index}`}>· {name}</span>
          ))}
        </div>
      ) : null}

      {text ? (
        <div
          className={cn(
            'min-w-0 max-w-full',
            message.role === 'user'
              ? 'max-w-[min(86%,44rem)] rounded-xl border bg-(--dt-user-bubble) px-3 py-2'
              : 'w-full'
          )}
        >
          <CompactMarkdown text={text} />
        </div>
      ) : null}
    </div>
  )
})

/**
 * Bottom-anchored, because the last screen of a conversation is its end. The
 * column fills the viewport and the overflow is CLIPPED rather than scrolled:
 * the fade mask is what tells the eye there is more above, and a scrollbar on a
 * surface that takes no input is a lie.
 */
export const CachedTranscriptPreview = memo(function CachedTranscriptPreview({
  messages
}: {
  messages: ChatMessage[]
}) {
  if (!messages.length) {
    return null
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex flex-col justify-end overflow-hidden px-4 pb-24 opacity-45"
      data-slot="cached-transcript-preview"
      style={{ maskImage: FADE, WebkitMaskImage: FADE }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-(--conversation-turn-gap,1rem)">
        {messages.map(message => (
          <PreviewRow key={message.id} message={message} />
        ))}
      </div>
    </div>
  )
})
