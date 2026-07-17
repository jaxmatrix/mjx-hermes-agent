import { useAuiState } from '@assistant-ui/react'
import { type FC, type ReactNode, useEffect, useState } from 'react'

import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $busy, $messages } from '@/store/chat'

// Ported (lean) from apps/desktop/src/components/assistant-ui/thread/status.tsx.
// Only StreamStallIndicator is needed for Phase 4 (assistant message tail).
//
// FLAG(chat-port): desktop's compaction hint ($compactionActive), awaiting-input
// gate ($activeSessionAwaitingInput), active-turn timer key ($activeSessionId /
// $turnStartedAt), and the CenteredThreadSpinner / ResponseLoadingIndicator /
// BackgroundResumeNotice status rows are deferred — those stores/loader don't
// exist in universal yet. This keeps the plain "still thinking" tail signal.
const StatusRow: FC<{ children: ReactNode; label: string } & React.ComponentPropsWithoutRef<'div'>> = ({
  children,
  label,
  className,
  ...rest
}) => (
  <div
    aria-label={label}
    aria-live="polite"
    className={cn('flex max-w-full items-center gap-2 self-start text-sm text-muted-foreground/70', className)}
    role="status"
    {...rest}
  >
    {children}
  </div>
)

// Pre-first-token "working" indicator (ported from desktop's
// ResponseLoadingIndicator). Rendered as the thread's `loadingIndicator` at the
// bottom of the list. Shows the pulsing square + elapsed timer from the moment
// the turn starts (sendPrompt sets $busy) until the assistant produces its first
// part — the empty running message renders null, so without this nothing signals
// that work is underway and it reads as "stopped". Once ANY content arrives the
// message body + its tail StreamStallIndicator take over, so this self-hides.
export const ResponseLoadingIndicator: FC = () => {
  const { t } = useI18n()
  const busy = useStore($busy)
  const messages = useStore($messages)

  const last = messages[messages.length - 1]
  const waiting = busy && (!last || last.role !== 'assistant' || last.parts.length === 0)

  const elapsed = useElapsedSeconds(waiting)

  if (!waiting) {
    return null
  }

  return (
    <StatusRow className="mt-1.5" data-slot="aui_response-loading" label={t.assistant.thread.loadingResponse}>
      <span aria-hidden="true" className="dither inline-block size-3 rounded-[2px] text-midground/80 animate-pulse" />
      <ActivityTimerText seconds={elapsed} />
    </StatusRow>
  )
}

// Seconds of no visible output (text or part count) before a still-running turn
// is treated as stalled and the thinking indicator returns at the tail.
const STREAM_STALL_S = 2

// Tail "still thinking" indicator: the pre-first-token spinner goes away once
// text flows, but if the stream then goes quiet mid-turn (tool think-time,
// provider stall) nothing signals that work continues. Watch a per-flush
// activity signal; when it hasn't changed for STREAM_STALL_S, re-show the
// dither + a timer counting from the last activity.
//
// Subscribes to the activity signal ITSELF (rather than taking it as a prop)
// so that per-token updates re-render only this leaf, not the whole
// AssistantMessage subtree.
export const StreamStallIndicator: FC = () => {
  const activity = useAuiState(s => {
    let textLength = 0

    for (const part of s.message.content) {
      const text = (part as { text?: unknown }).text

      if (typeof text === 'string') {
        textLength += text.length
      }
    }

    return `${s.message.content.length}:${textLength}`
  })

  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    setStalled(false)
    const id = window.setTimeout(() => setStalled(true), STREAM_STALL_S * 1000)

    return () => window.clearTimeout(id)
  }, [activity])

  const elapsed = useElapsedSeconds(stalled)

  if (!stalled) {
    return null
  }

  return (
    <StatusRow className="mt-1.5" data-slot="aui_stream-stall" label="Hermes is thinking">
      <span aria-hidden="true" className="dither inline-block size-3 rounded-[2px] text-midground/80 animate-pulse" />
      <ActivityTimerText seconds={elapsed} />
    </StatusRow>
  )
}
