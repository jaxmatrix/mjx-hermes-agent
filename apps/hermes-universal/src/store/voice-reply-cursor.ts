import type { SessionView } from '@/app/chat/session-view'
import { type ChatMessage, chatMessageText, collectUnspokenTurnSpeech } from '@/lib/chat-messages'

// The shared "last spoken reply" cursor, dedupe between the voice-conversation
// loop and `useAutoSpeakReplies` so a reply is never read aloud twice. Keyed per
// SessionView (a WeakMap), so it is per-session — a tile's conversation reads that
// tile's replies, not the primary chat's (the pre-existing bug where
// `use-composer-voice` closed over the global `$messages`). Session switches on the
// primary view are handled by `useAutoSpeakReplies` re-marking on `sessionId`.
//
// WHY THE CURSOR IS NOT AN ID (MJXHRM-484, desktop's `lib/spoken-reply.ts` +
// fix 63565fa26b). A row id in this app is ephemeral by design — `chat-messages.ts`
// says so on `rowId`: "a live row, the same row rehydrated from history, and an
// optimistic one are all shaped differently, and a resume regenerates them". The
// reply we just read aloud streams in under `m<N>-<ts>` (`nextId()`) and is then
// REPLACED, same reply, by the authoritative `h<N>-assistant` row when
// `lib/live-tail.ts` `reconcileLiveTail` runs — on a cold-open rekey
// (`store/turn-hydration.ts`) or a reconnect resume (`store/turn-lifecycle.ts`
// `reconcileSessionTail`). An id-keyed cursor sees a stranger and reads the turn
// again; worse, `collectUnspokenTurnSpeech` starts from index 0 when it cannot
// find the cursor id at all, so the conversation loop narrates the WHOLE session.
//
// So the cursor is an ANCHOR: the id plus the reply's ORDINAL among visible
// assistant bubbles. The rewrite keeps that slot — `reconcileResumeMessages`
// pairs local rows against authoritative ones by role ordinal for the same
// reason — and a new turn appends, moving the ordinal. A content fingerprint
// would not do: two turns that both say "Done." are two turns.
//
// Not desktop's `isLiveTailReplyId` prefix guard: universal's live ids carry no
// such prefix (`assistant-stream-` here is only the reconnect PROJECTION in
// `lib/session-history.ts`), so the guard would be dead code and the migration
// it gates would never run.

export interface VoiceReply {
  id: string
  pending: boolean
  text: string
}

interface SpokenAnchor {
  id: string
  /** Index among visible assistant bubbles at the time it was marked. */
  ordinal: number
}

const spokenByView = new WeakMap<SessionView, SpokenAnchor>()

// Universal's ChatMessage has no `hidden` field (desktop's does); the widening
// cast keeps the port honest if one is ever added.
function visibleAssistants(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(m => m.role === 'assistant' && !(m as { hidden?: boolean }).hidden)
}

/**
 * The spoken cursor as an id that EXISTS in the current transcript, migrating
 * the anchor onto the row that now occupies its slot.
 *
 * The anchor's ordinal is refreshed whenever it moves, so a transcript that
 * grew a bubble ahead of the spoken one does not strand it. If the slot is gone
 * entirely — no path in universal drops committed rows today, since there is no
 * post-turn re-hydrate (`store/compaction.ts`), but a shrinking transcript is
 * cheap to survive — the cursor clamps to the newest reply: a transcript we can
 * no longer line up is not evidence that something new was said, and silence
 * beats reading a session back.
 */
function resolveSpokenId(view: SessionView, messages: ChatMessage[]): null | string {
  const anchor = spokenByView.get(view)

  if (!anchor) {
    return null
  }

  const replies = visibleAssistants(messages)

  if (replies.length === 0) {
    return null
  }

  const found = replies.findIndex(m => m.id === anchor.id)
  const ordinal = found >= 0 ? found : Math.min(anchor.ordinal, replies.length - 1)
  const row = replies[ordinal]

  if (row.id !== anchor.id || ordinal !== anchor.ordinal) {
    spokenByView.set(view, { id: row.id, ordinal })
  }

  return row.id
}

/** The latest completed/streaming assistant reply not yet marked spoken, else null. */
export function lastReply(view: SessionView): VoiceReply | null {
  const messages = view.$messages.get()
  const replies = visibleAssistants(messages)
  const last = replies[replies.length - 1]

  if (!last || last.id === resolveSpokenId(view, messages)) {
    return null
  }

  const text = chatMessageText(last).trim()

  if (!text) {
    return null
  }

  return { id: last.id, pending: Boolean(last.pending), text }
}

/**
 * The WHOLE unspoken turn — every assistant bubble since the cursor, joined —
 * not just the newest one.
 *
 * This is what the conversation loop narrates. `lastReply` above stays the
 * auto-speak selector: a read-aloud backlog deliberately collapses to the newest
 * reply, while a hands-free turn must be heard in full (narration interims AND
 * the final answer). See `collectUnspokenTurnSpeech`.
 */
export function unspokenTurn(view: SessionView): null | VoiceReply {
  const messages = view.$messages.get()

  return collectUnspokenTurnSpeech(messages, resolveSpokenId(view, messages))
}

/** Mark the current last reply as spoken (dedupe cursor advance). */
export function markReplySpoken(view: SessionView): void {
  const replies = visibleAssistants(view.$messages.get())
  const last = replies[replies.length - 1]

  if (last) {
    spokenByView.set(view, { id: last.id, ordinal: replies.length - 1 })
  }
}
