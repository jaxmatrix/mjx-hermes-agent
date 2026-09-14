import { atom, computed } from 'nanostores'

import { type SessionView } from '@/app/chat/session-view'
import { type ChatMessage } from '@/store/chat'
import { $sessionStates } from '@/store/session-state-types'
import { $sessionTiles, tileRuntimeKey } from '@/store/session-states'
import { $transcriptPaint } from '@/store/transcript-paint'

/**
 * A `SessionView` for ONE stored session — the non-primary half of
 * `app/chat/session-view.ts`'s contract.
 *
 * Lifted out of `session-tile.tsx`, where it was private and called
 * `buildTileView`, because a tile is not the only surface that renders a
 * session it names: `SessionThread` mounts the app's own transcript for any
 * foreign session (Bot Mode's room member cards), and a second copy of this
 * derivation is exactly how two surfaces start disagreeing about which slice a
 * session is in after a background auto-compaction.
 *
 * `kind` stays `'tile'`: it is read as "not the primary view", and every
 * consumer branches on that meaning.
 */

const NO_MESSAGES: ChatMessage[] = []

function lastVisibleIsUser(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') {
      continue
    }

    return messages[i].role === 'user'
  }

  return false
}

/** A SessionView driven entirely by the tile's `$sessionStates` slice — the same
 *  shape the primary chat's PRIMARY_SESSION_VIEW provides, so one ChatScreen
 *  serves both. */
export function buildSessionView(storedSessionId: string): SessionView {
  // Resolved through the reverse index (which carries lineage aliases) rather
  // than the tile's cached runtimeId, so the tile follows its session across a
  // background auto-compaction instead of pointing at a dead slice (MJX-133).
  const $runtimeId = computed([$sessionTiles, $sessionStates], () => tileRuntimeKey(storedSessionId))

  const $state = computed([$runtimeId, $sessionStates], (rt, states) => (rt ? states[rt] : undefined))
  const $messages = computed($state, s => s?.messages ?? NO_MESSAGES)

  // The tile's own paint lane slot, keyed by the same slice key its `$messages`
  // read from — so a QUAD layout restored at boot paints each cold tile's own
  // cached tail rather than leaving four blank panes beside one painted one.
  const $paintedMessages = computed([$messages, $transcriptPaint, $runtimeId], (messages, paint, key) =>
    messages.length || !key ? messages : (paint[key]?.messages ?? messages)
  )

  return {
    kind: 'tile',
    $runtimeId,
    $storedId: atom(storedSessionId),
    $messages,
    $paintedMessages,
    $paintedMessagesEmpty: computed($paintedMessages, m => m.length === 0),
    $busy: computed($state, s => Boolean(s?.busy)),
    $awaitingResponse: computed($state, s => Boolean(s?.awaitingResponse)),
    $messagesEmpty: computed($messages, m => m.length === 0),
    $lastVisibleIsUser: computed($messages, lastVisibleIsUser),
    $statusLine: computed($state, s => s?.statusLine ?? ''),
    $cwd: computed($state, s => s?.cwd ?? ''),
    $model: computed($state, s => s?.model ?? ''),
    $provider: computed($state, s => s?.provider ?? ''),
    $fast: computed($state, s => Boolean(s?.fast)),
    $reasoningEffort: computed($state, s => s?.reasoningEffort ?? '')
  }
}

