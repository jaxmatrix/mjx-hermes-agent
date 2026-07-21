// Universal adapter for the ported composer. Desktop's chat-runtime.ts is a
// 400-line runtime pipeline pulling in desktop-app-shell types (@/app/types)
// the universal app doesn't have. The composer only needs these three
// self-contained helpers, reproduced verbatim from desktop.

import type { SessionInfo } from '@/types/hermes'

/** Matches a leading slash command token (`/foo` or `/foo `) at the start of a draft. */
export const SLASH_COMMAND_RE = /^\/[^\s/]*(?:\s|$)/

/** Human-readable session title: title → preview → fallback. */
export function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.preview?.trim() || 'Untitled session'
}

// Reasoning/thinking payload normalization, ported verbatim from desktop's
// chat-runtime.ts. The gateway's thinking channel carries the kawaii spinner
// status ("◉_◉ processing… <verb>") and the model's own placeholder echoes;
// neither is real reasoning, and without this they render as thinking blocks.
const THINKING_STATUS_PREFIX_RE =
  /^\s*(?:(?:[^\s.]{1,16})\s+)?(?:processing|thinking|reasoning|analyzing|pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|computing|synthesizing|formulating|brainstorming)\.\.\.\s*/i

const EMPTY_THINKING_PLACEHOLDER_RE =
  /\b(?:current rewritten thinking|next thinking to process|provide the thinking content|don't see any .*thinking)\b/i

/** Flatten a gateway text payload (string, array of chunks, or {text}/{output_text}). */
export function coerceGatewayText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(coerceGatewayText).join('')
  }

  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>

    if (typeof row.text === 'string') {
      return row.text
    }

    if (typeof row.output_text === 'string') {
      return row.output_text
    }
  }

  return ''
}

/**
 * Normalize a reasoning/thinking text payload from the gateway.
 *
 * Only the leading status prefix (e.g. "Hermes is thinking...") and the
 * obvious placeholder echoes are stripped. We deliberately do NOT trim
 * the delta — reasoning streams as small chunks (often individual tokens
 * with leading or trailing spaces), and trimming each chunk before
 * concatenation collapses adjacent words together. Whitespace between
 * tokens belongs to the data, not chrome.
 */
export function coerceThinkingText(value: unknown): string {
  const raw = coerceGatewayText(value).replace(THINKING_STATUS_PREFIX_RE, '')

  return EMPTY_THINKING_PLACEHOLDER_RE.test(raw) ? '' : raw
}

/** Display a path relative to cwd (strip the cwd prefix when present). */
export function contextPath(path: string, cwd: string): string {
  if (!cwd) {
    return path
  }

  const normalizedCwd = cwd.endsWith('/') ? cwd : `${cwd}/`

  return path.startsWith(normalizedCwd) ? path.slice(normalizedCwd.length) : path
}
