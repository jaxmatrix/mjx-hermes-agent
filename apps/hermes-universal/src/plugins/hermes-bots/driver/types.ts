/**
 * WHERE A MEMBER TURN ACTUALLY RUNS — the one abstraction this feature earns.
 *
 * v1 is a JS loop in the webview, and a JS loop dies with a suspended WebView:
 * on Android and iOS the OS parks the whole process the moment the app is
 * backgrounded, and a room mid-drive simply stops. v2 is a tokio task behind
 * `bot_room_run_turn` that outlives the webview as far as the OS allows.
 *
 * This interface exists so v2 is a DROP-IN: `driver/rounds.ts`, the model and
 * every UI file are written against it, so the swap is one line in `plugin.tsx`
 * and nothing else changes.
 *
 * `survivesSuspension` is the honest half. The pause contract (§8.6) reads it
 * rather than assuming: a runner that keeps going does not pause, and a runner
 * that does not keep going says so to the user instead of pretending.
 */

export interface RoomTurnMember {
  profile: string
  connectionId?: string
  storedSessionId: string
  runtimeSessionId?: null | string
}

export interface RoomTurnPlan {
  roomId: string
  threadId: string
  /** Invalidates the turn if the room has moved on. */
  epoch: number
  member: RoomTurnMember
  prompt: string
  refs: { name: string; ref: string }[]
  timeoutMs: number
  hardCapMs: number
}

export type RoomTurnOutcome =
  | { status: 'reply'; text: string }
  | { status: 'pass' }
  /** Timed out. `strandedBefore` is the member's message count at submit, so a
   *  late reply can be harvested on the next drive. */
  | { status: 'timeout'; strandedBefore: number }
  /** Already running — do NOT submit a second prompt into it. */
  | { status: 'busy' }
  | { status: 'superseded' }
  | { status: 'paused'; reason: PauseReason }
  /** Shaped, never a bare throw (rule 8/9). */
  | { status: 'error'; message: string }

export type PauseReason = 'backgrounded' | 'disconnected'

export interface RoomTurnRunner {
  readonly id: string
  /**
   * Does a turn keep progressing while the webview is suspended?
   *
   * REPORTED, not claimed: the Rust runner answers `platform()`-dependently
   * (Android keeps the process alive; iOS gives a background budget and then
   * takes it away), and the UI promises the user only what this says.
   */
  readonly survivesSuspension: boolean
  run(plan: RoomTurnPlan, signal: AbortSignal): Promise<RoomTurnOutcome>
}

/** Constants. Kept from desktop: they encode real model behaviour — how long a
 *  turn plausibly takes, how many rounds a conversation needs before it is
 *  repeating itself — not an implementation detail. */
export const GROUP_CHAT_MAX_ROUNDS = 3
export const GROUP_CHAT_MAX_MESSAGES = 10
export const GROUP_TURN_TIMEOUT_MS = 180_000
export const GROUP_TURN_HARD_CAP_MS = 1_200_000
/** How long after a member goes idle we still wait for its last delta. */
export const GROUP_TURN_IDLE_GRACE_MS = 20_000
export const REMOTE_DM_TIMEOUT_MS = 180_000
/** Messages read per member on a cold room rebuild. */
export const GROUP_LOG_FETCH_LIMIT = 120
