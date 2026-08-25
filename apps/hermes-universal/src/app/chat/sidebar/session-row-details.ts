import type { SessionInfo } from '@/types/hermes'

/**
 * The extra lines a non-compact sidebar row shows. Ported verbatim in behaviour
 * from desktop `app/chat/sidebar/session-row-details.ts`.
 *
 * Pure and deterministic on purpose: the row is virtualised on desktop and
 * re-rendered constantly here, so anything that reads a store or formats a
 * relative time would either churn or lie. Everything below comes off the row.
 */
export interface SessionRowDetails {
  metadata: string
  preview: null | string
}

export interface SessionRowFormatters {
  messageCount: (count: number) => string
  toolCallCount: (count: number) => string
}

/** `anthropic/claude-x` → `claude-x`. The provider prefix is noise on a row this
 *  narrow, and every row of a profile carries the same one. */
const modelLabel = (model: null | string) => model?.split('/').pop()?.trim() || null

const oneLine = (value: null | string) => value?.replace(/\s+/g, ' ').trim() || null

export function sessionRowDetails(session: SessionInfo, fmt: SessionRowFormatters): SessionRowDetails {
  const preview = oneLine(session.preview)
  const hasOwnTitle = Boolean(session.title?.trim())

  const metadata = [
    session.git_branch?.trim() || null,
    modelLabel(session.model),
    session.message_count > 0 ? fmt.messageCount(session.message_count) : null,
    session.tool_call_count > 0 ? fmt.toolCallCount(session.tool_call_count) : null
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    metadata,
    // A row with no title of its own ALREADY renders the preview as its title
    // (`sessionTitle` falls back to it), so repeating it underneath would print
    // the same sentence twice.
    preview: hasOwnTitle ? preview : null
  }
}
