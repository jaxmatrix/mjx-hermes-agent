/**
 * The THIRD implementation of `RoomTurnRunner`, and the one that exists from
 * day one.
 *
 * An interface with a single implementation is speculative; an interface with a
 * test double is load-bearing immediately. This is what lets the rounds engine's
 * whole suite — caps, rotation, supersede, strand, harvest, pause — run with no
 * gateway, no webview and no clock.
 */

import type { RoomTurnOutcome, RoomTurnPlan, RoomTurnRunner } from './types'

export interface FakeRunner extends RoomTurnRunner {
  /** Every plan the engine handed over, in order. */
  readonly plans: RoomTurnPlan[]
  /** Queue an outcome for the next turn; falls back to `(pass)`. */
  queue(...outcomes: RoomTurnOutcome[]): void
  /** Run this before answering the next turn — the hook a test uses to move the
   *  world (bump the epoch, pause the room) mid-drive. */
  onTurn(fn: (plan: RoomTurnPlan) => Promise<void> | void): void
}

export function createFakeRunner(options: { survivesSuspension?: boolean } = {}): FakeRunner {
  const plans: RoomTurnPlan[] = []
  const queued: RoomTurnOutcome[] = []

  let hook: ((plan: RoomTurnPlan) => Promise<void> | void) | null = null

  return {
    id: 'fake',
    onTurn(fn) {
      hook = fn
    },
    plans,
    queue(...outcomes) {
      queued.push(...outcomes)
    },
    async run(plan, signal) {
      plans.push(plan)

      await hook?.(plan)

      if (signal.aborted) {
        return { status: 'superseded' }
      }

      return queued.shift() ?? { status: 'pass' }
    },
    survivesSuspension: options.survivesSuspension ?? false
  }
}
