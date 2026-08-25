/**
 * The v1 runner: submit the prompt, then WAIT ON THE SLICE.
 *
 * Desktop polled `session.resume` every two seconds per member. It does not
 * have to: MJXHRM-445's member sessions are real `$sessionStates` slices, so the
 * event router already writes each member's deltas, its `busy` flag and its
 * blocking prompts. The wait below is a nanostores subscription with a timer as
 * the DEADLINE — not a poll with a subscription bolted on.
 *
 * `extendWhile` is why the deadline is not simply a timeout: a member that is
 * visibly working, or parked on a clarify question waiting for the user, has not
 * failed. It keeps its turn up to the hard cap, and only then is stranded.
 */

import { isPassText } from '../model/mentions'

import type { RoomTurnOutcome, RoomTurnPlan, RoomTurnRunner } from './types'

/** Everything the runner needs from the host, injected so the wait is testable
 *  without a gateway. */
export interface WebviewRunnerDeps {
  /** Submit the prompt into the member's LIVE runtime session. */
  submit(plan: RoomTurnPlan): Promise<void>
  /** The member's slice: message count, busy flag, and whether it is parked on
   *  a question. */
  observe(plan: RoomTurnPlan): TurnObserver
  /** The newest settled assistant text after `before` messages, or null. */
  settledText(plan: RoomTurnPlan, before: number): null | string
  now(): number
}

/**
 * The two things the wait needs: read now, and tell me when it changes.
 *
 * Narrower than `ReadableAtom` on purpose — a member's state is stitched
 * together from THREE host atoms (its messages, the busy map, its prompts), and
 * demanding a single atom would force the caller to mint a `computed` whose
 * only purpose is to satisfy a type.
 */
export interface TurnObserver {
  get(): MemberTurnState
  listen(fn: () => void): () => void
}

export interface MemberTurnState {
  messages: number
  busy: boolean
  /** Parked on an approval / clarify / secret — waiting on the USER, not stuck. */
  awaitingInput: boolean
}

export function createWebviewRunner(deps: WebviewRunnerDeps): RoomTurnRunner {
  return {
    id: 'webview',
    async run(plan, signal): Promise<RoomTurnOutcome> {
      const state = deps.observe(plan)
      const before = state.get().messages
      const startedAt = deps.now()

      try {
        await deps.submit(plan)
      } catch (error) {
        return { message: error instanceof Error ? error.message : String(error), status: 'error' }
      }

      const settled = await waitForTurn(deps, plan, state, before, startedAt, signal)

      if (settled.status !== 'reply') {
        return settled
      }

      // `(pass)` is a real answer that is not a message. Classified HERE rather
      // than in the engine so a v2 Rust runner answers the same shape.
      return isPassText(settled.text) ? { status: 'pass' } : settled
    },
    // The whole reason the pause contract exists: a suspended WebView stops
    // running this promise, and no amount of care in here changes that.
    survivesSuspension: false
  }
}

async function waitForTurn(
  deps: WebviewRunnerDeps,
  plan: RoomTurnPlan,
  state: TurnObserver,
  before: number,
  startedAt: number,
  signal: AbortSignal
): Promise<RoomTurnOutcome> {
  return new Promise<RoomTurnOutcome>(resolve => {
    let done = false

    const finish = (outcome: RoomTurnOutcome) => {
      if (done) {
        return
      }

      done = true
      unsubscribe()
      clearInterval(tick)
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }

    const onAbort = () => finish({ status: 'superseded' })

    const check = () => {
      const snapshot = state.get()

      if (snapshot.messages > before && !snapshot.busy) {
        const text = deps.settledText(plan, before)

        if (text !== null) {
          finish({ status: 'reply', text })
        }
      }
    }

    // The DEADLINE, not a poll: `check` runs on every slice change. This timer
    // only decides when to give up — and extends while the member is visibly
    // working or parked on a question, because neither of those is a failure.
    const tick = setInterval(() => {
      const elapsed = deps.now() - startedAt
      const snapshot = state.get()

      if (elapsed >= plan.hardCapMs) {
        finish({ status: 'timeout', strandedBefore: before })

        return
      }

      if (elapsed >= plan.timeoutMs && !snapshot.busy && !snapshot.awaitingInput) {
        finish({ status: 'timeout', strandedBefore: before })
      }
    }, 1_000)

    const unsubscribe = state.listen(check)

    signal.addEventListener('abort', onAbort)

    // A turn that had already settled before we subscribed.
    check()
  })
}
