/**
 * The per-runtime session-state record + its shared atom — a LEAF module so
 * both `store/session.ts` (which unions tile busy/needsInput into
 * `$workingSessionIds`/`$attentionSessionIds`) and `store/session-states.ts`
 * (which owns the publish/transition/tiles logic) can read `$sessionStates`
 * without an import cycle. The type imports are erased at build, so this file
 * has no runtime deps beyond nanostores.
 *
 * In universal, `$sessionStates` holds TILE (non-primary) sessions only; the
 * PRIMARY chat stays on the global `store/chat.ts` atoms, projected into this
 * shape by `$primarySessionState` (see session-states.ts).
 */

import { atom } from 'nanostores'

import type { ChatMessage } from '@/store/chat'
import type { UsageStats } from '@/types/hermes'

/** The full client-side state of ONE session — the unit a tile renders from
 *  and the reducer writes per runtime id. Ported from desktop `app/types.ts`. */
export interface ClientSessionState {
  storedSessionId: string | null
  messages: ChatMessage[]
  branch: string
  cwd: string
  model: string
  provider: string
  reasoningEffort: string
  serviceTier: string
  fast: boolean
  yolo: boolean
  personality: string
  busy: boolean
  awaitingResponse: boolean
  streamId: string | null
  sawAssistantPayload: boolean
  pendingBranchGroup: string | null
  interrupted: boolean
  /** An interim finalized a bubble mid-turn. */
  interimBoundaryPending: boolean
  /** A blocking clarify prompt is waiting → sidebar "needs input". */
  needsInput: boolean
  /** Per-session turn clock (epoch ms). */
  turnStartedAt: number | null
  /** Per-session cumulative token usage. */
  usage: null | UsageStats
}

/** An empty state for a freshly-opened tile before its resume binds. */
export function emptySessionState(storedSessionId: string | null = null): ClientSessionState {
  return {
    storedSessionId,
    messages: [],
    branch: '',
    cwd: '',
    model: '',
    provider: '',
    reasoningEffort: '',
    serviceTier: '',
    fast: false,
    yolo: false,
    personality: '',
    busy: false,
    awaitingResponse: false,
    streamId: null,
    sawAssistantPayload: false,
    pendingBranchGroup: null,
    interrupted: false,
    interimBoundaryPending: false,
    needsInput: false,
    turnStartedAt: null,
    usage: null
  }
}

/** Runtime id → state, for TILE (non-primary) sessions. Republished on every
 *  message delta; derived sets guard with `stableArray` to avoid re-render storms. */
export const $sessionStates = atom<Record<string, ClientSessionState>>({})
