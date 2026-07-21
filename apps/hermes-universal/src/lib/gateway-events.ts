// Session routing for gateway events, ported verbatim from
// apps/desktop/src/lib/gateway-events.ts (the desktop file also carries
// statusbar log helpers, which universal builds elsewhere).
//
// Universal keeps ONE transcript ($messages) for the focused chat, so without
// this a background session's tool/message events render in whatever chat
// happens to be open, and switching chats mid-turn drags the previous turn's
// remaining tool events into the new transcript.

/**
 * Unscoped stream events that must stay pinned to the session that received
 * ``message.start`` after the user switches chats mid-turn (#47709 / #48281).
 * Without this, ``explicitSid || activeSessionId`` reattributes live deltas to
 * the newly focused chat.
 */
const UNSCOPED_STREAM_EVENT_TYPES = new Set([
  'approval.request',
  'browser.progress',
  'clarify.request',
  'error',
  'message.complete',
  'message.delta',
  'message.start',
  'reasoning.available',
  'reasoning.delta',
  'secret.request',
  'status.update',
  'sudo.request',
  'thinking.delta',
  'tool.complete',
  'tool.generating',
  'tool.progress',
  'tool.start'
])

const UNSCOPED_STREAM_END_EVENT_TYPES = new Set(['error', 'message.complete'])

/**
 * Whether an unscoped event (no `session_id`) must be dropped rather than
 * attributed to the focused chat.
 *
 * Only `subagent.*` qualifies: it describes background/async work that must
 * never attach to whichever chat happens to be focused. Every other scoped
 * event — message/reasoning/thinking/tool/status/prompt — is, when unscoped,
 * the active turn's own output. The gateway always stamps a *background*
 * session's events with that session's id, so a missing id can only mean "the
 * focused turn". #42178 dropped those too, which silently swallowed the live
 * answer; it then reappeared only after a transcript refetch (manual refresh).
 */
export function gatewayEventRequiresSessionId(eventType: string | undefined): boolean {
  return eventType?.startsWith('subagent.') ?? false
}

export interface GatewayEventSessionRouteInput {
  activeSessionId: null | string
  eventType: string | undefined
  explicitSessionId: string
  unscopedStreamSessionId: null | string
}

export interface GatewayEventSessionRoute {
  drop: boolean
  nextUnscopedStreamSessionId: null | string
  sessionId: null | string
}

/**
 * Resolve which runtime session owns a gateway event.
 *
 * Explicit ``session_id`` always wins. Unscoped stream events pin to the
 * session that received ``message.start`` so a mid-turn chat switch cannot
 * steal live deltas / tool events onto the newly focused transcript.
 */
export function resolveGatewayEventSessionId({
  activeSessionId,
  eventType,
  explicitSessionId,
  unscopedStreamSessionId
}: GatewayEventSessionRouteInput): GatewayEventSessionRoute {
  if (explicitSessionId) {
    const nextUnscopedStreamSessionId =
      eventType && UNSCOPED_STREAM_END_EVENT_TYPES.has(eventType) && explicitSessionId === unscopedStreamSessionId
        ? null
        : unscopedStreamSessionId

    return {
      drop: false,
      nextUnscopedStreamSessionId,
      sessionId: explicitSessionId
    }
  }

  if (gatewayEventRequiresSessionId(eventType)) {
    return {
      drop: true,
      nextUnscopedStreamSessionId: unscopedStreamSessionId,
      sessionId: null
    }
  }

  const streamEvent = eventType ? UNSCOPED_STREAM_EVENT_TYPES.has(eventType) : false

  const sessionId =
    eventType === 'message.start'
      ? activeSessionId
      : streamEvent
        ? unscopedStreamSessionId || activeSessionId
        : activeSessionId

  let nextUnscopedStreamSessionId = unscopedStreamSessionId

  if (eventType === 'message.start' && activeSessionId) {
    nextUnscopedStreamSessionId = activeSessionId
  } else if (eventType && UNSCOPED_STREAM_END_EVENT_TYPES.has(eventType)) {
    nextUnscopedStreamSessionId = null
  }

  return {
    drop: false,
    nextUnscopedStreamSessionId,
    sessionId
  }
}
