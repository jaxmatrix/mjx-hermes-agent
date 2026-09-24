import { computed, type ReadableAtom } from 'nanostores'
import { createContext, useContext } from 'react'

import { $primaryBusy } from '@/app/chat/primary-session-busy'
import type { ClientSessionState } from '@/app/types'
import type { ChatMessage } from '@/lib/chat-messages'
import type { ChatMessage as LegacyChatMessage } from '@/lib/session-key-messages'
import { $statusLine } from '@/store/chat'
import {
  $activeSessionId,
  $awaitingResponse,
  $currentCwd,
  $currentFastMode,
  $currentModel,
  $currentProvider,
  $currentReasoningEffort,
  $currentReasoningEffortWire,
  $messages,
  $selectedStoredSessionId,
  $turnStartedAt
} from '@/store/session'
import type { BranchSource } from '@/store/session-lifecycle'
import { $sessionStates } from '@/store/session-states'

import { lastVisibleMessageIsUser } from './thread-loading'

/**
 * SESSION VIEW — the store surface a ChatView renders from. Every session,
 * including the one in the workspace pane, renders from ITS OWN slice of
 * `$sessionStates`. The workspace pane is just the first tab: a session
 * surface with no privileged state of its own.
 *
 * That symmetry is load-bearing. The pane used to render off the global
 * `$messages`/`$busy` atoms — a mirror of whichever session was active — so
 * with two turns in flight (⌘T tabs made that routine), navigating away from
 * a still-streaming session left it painting into the surface now showing a
 * different conversation. Reading the per-session slice makes that
 * structurally impossible rather than merely guarded.
 *
 * The global atoms stay the DRAFT surface: a new chat has no runtime id, and
 * therefore no slice, until its first turn creates one.
 *
 * Everything is atoms (not values) so subscription granularity survives:
 * ChatView subscribes only to the coarse edges; `$messages` stays boundary-
 * only exactly like the primary view's perf contract.
 */
export interface SessionView {
  kind: 'primary' | 'tile'
  $runtimeId: ReadableAtom<string | null>
  $storedId: ReadableAtom<string | null>
  $messages: ReadableAtom<ChatMessage[]>
  /** Paint-lane transcript; equals `$messages` when no cached tail is active. */
  $paintedMessages: ReadableAtom<ChatMessage[]>
  $busy: ReadableAtom<boolean>
  $awaitingResponse: ReadableAtom<boolean>
  $messagesEmpty: ReadableAtom<boolean>
  $lastVisibleIsUser: ReadableAtom<boolean>
  /** Epoch ms this surface's current turn began, null when idle. Per-surface
   *  for the same reason $busy is: a tile's activity timer must count its own
   *  turn, not whichever session the global mirror last reflected. */
  $turnStartedAt: ReadableAtom<number | null>
  $cwd: ReadableAtom<string>
  $model: ReadableAtom<string>
  $provider: ReadableAtom<string>
  $fast: ReadableAtom<boolean>
  $reasoningEffort: ReadableAtom<string>
  /** Gateway-reported level the route sends for `$reasoningEffort` ('' = unknown). */
  $reasoningEffortWire: ReadableAtom<string>
  /** Mid-turn status text while busy (primary session state only). */
  $statusLine?: ReadableAtom<string>
}

/** The active session's own slice, or `undefined` while it's a draft. */
const $primaryState = computed([$activeSessionId, $sessionStates], (runtimeId, states) =>
  runtimeId ? states[runtimeId] : undefined
)

/**
 * Read one field from the active session's slice, falling back to the global
 * draft atom while no runtime exists yet. Once a session HAS a slice, that
 * slice is authoritative — a background session publishing its own state can
 * never reach this view.
 */
function primaryField<T>(select: (state: ClientSessionState) => T, $draft: ReadableAtom<T>): ReadableAtom<T> {
  const $field: ReadableAtom<T> = computed([$primaryState, $draft], (state, draft: T) =>
    state ? select(state) : draft
  )

  return $field
}

const $primaryMessages = primaryField<ChatMessage[]>(state => state.messages, $messages)

export const PRIMARY_SESSION_VIEW: SessionView = {
  kind: 'primary',
  $awaitingResponse: primaryField<boolean>(state => state.awaitingResponse, $awaitingResponse),
  $busy: $primaryBusy,
  $cwd: primaryField<string>(state => state.cwd, $currentCwd),
  $fast: primaryField<boolean>(state => state.fast, $currentFastMode),
  $lastVisibleIsUser: computed($primaryMessages, lastVisibleMessageIsUser),
  $messages: $primaryMessages,
  $paintedMessages: $primaryMessages,
  $messagesEmpty: computed($primaryMessages, messages => messages.length === 0),
  $model: primaryField<string>(state => state.model, $currentModel),
  $provider: primaryField<string>(state => state.provider, $currentProvider),
  $reasoningEffort: primaryField<string>(state => state.reasoningEffort, $currentReasoningEffort),
  $reasoningEffortWire: primaryField<string>(state => state.reasoningEffortWire ?? '', $currentReasoningEffortWire),
  $runtimeId: $activeSessionId,
  $storedId: $selectedStoredSessionId,
  $statusLine: primaryField<string>(state => state.statusLine, $statusLine),
  $turnStartedAt: primaryField<number | null>(state => state.turnStartedAt, $turnStartedAt)
}

const SessionViewContext = createContext<SessionView>(PRIMARY_SESSION_VIEW)

export const SessionViewProvider = SessionViewContext.Provider

export const useSessionView = (): SessionView => useContext(SessionViewContext)

/** Branch source for a specific chat surface (tile/mobile bubble), not the foreground atoms. */
export function branchSourceOf(view: SessionView): BranchSource {
  return {
    busy: view.$busy.get(),
    cwd: view.$cwd.get(),
    messages: view.$messages.get() as LegacyChatMessage[],
    runtimeId: view.$runtimeId.get(),
    storedId: view.$storedId.get()
  }
}
