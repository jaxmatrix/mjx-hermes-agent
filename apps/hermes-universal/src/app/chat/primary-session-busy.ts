/**
 * Workspace-pane turn-busy, without importing `session-view` (which pulls
 * `store/chat` → `store/pet` → this signal — a cycle that left
 * `PRIMARY_SESSION_VIEW` undefined under Vitest).
 *
 * Same rule as in `session-view.tsx`: a selected stored session with no slice
 * yet stays idle; the global `$busy` draft is only for a true new chat.
 */

import { computed, type ReadableAtom } from 'nanostores'

import type { ClientSessionState } from '@/app/types'
import { $activeSessionId, $busy, $selectedStoredSessionId } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

const $primaryState = computed([$activeSessionId, $sessionStates], (runtimeId, states) =>
  runtimeId ? states[runtimeId] : undefined
)

export const $primaryBusy: ReadableAtom<boolean> = computed(
  [$primaryState, $busy, $selectedStoredSessionId],
  (state: ClientSessionState | undefined, draftBusy, selected) => (state ? state.busy : selected ? false : draftBusy)
)
