/**
 * Poll cadence helper: fast while the gateway lacks change-events, backstop
 * when `$changeEventsAvailable` is armed. Lives off AUTO `live-sync.ts`.
 */
import { $changeEventsAvailable } from '@/store/live-sync'

export function livePollIntervalMs(legacyMs: number, backstopMs: number): number {
  return $changeEventsAvailable.get() ? backstopMs : legacyMs
}
