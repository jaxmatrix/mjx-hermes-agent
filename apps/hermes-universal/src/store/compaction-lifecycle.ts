/**
 * The universal-only half of compaction state.
 *
 * `store/compaction.ts` is desktop's file, verbatim — the flag, its per-session
 * view and the writers the ported event pipeline
 * (`app/session/hooks/use-message-stream/gateway-event`) drives. That pipeline is
 * the ONE router for compaction frames; `store/event-router.ts` no longer folds
 * them. What lives here is what desktop has no counterpart for, built over
 * desktop's atom rather than beside it.
 */

import { $compactingSessions } from '@/store/compaction'

/** Wipe every session's compaction state — profile switch, gateway teardown. */
export function clearAllCompaction(): void {
  if (Object.keys($compactingSessions.get()).length > 0) {
    $compactingSessions.set({})
  }
}
