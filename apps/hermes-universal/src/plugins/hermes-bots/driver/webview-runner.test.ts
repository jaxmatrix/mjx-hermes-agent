/**
 * The v1 runner settles on the SLICE, not on a poll.
 *
 * Desktop resumed each member session every two seconds to notice a reply.
 * These pin that the wait is a subscription with a deadline: the only timer is
 * the give-up clock, and it extends while the member is visibly working or
 * parked on a question.
 */

import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoomTurnPlan } from './types'
import { createWebviewRunner, type MemberTurnState, type WebviewRunnerDeps } from './webview-runner'

const plan: RoomTurnPlan = {
  epoch: 1,
  hardCapMs: 60_000,
  member: { profile: 'radar', runtimeSessionId: 'rt-radar', storedSessionId: 's-radar' },
  prompt: 'go',
  refs: [],
  roomId: 'r_aaa',
  threadId: 'main',
  timeoutMs: 10_000
}

function harness(over: Partial<WebviewRunnerDeps> = {}) {
  const state = atom<MemberTurnState>({ awaitingInput: false, busy: false, messages: 3 })
  const submitted: RoomTurnPlan[] = []

  let now = 0
  let reply: null | string = null

  const deps: WebviewRunnerDeps = {
    now: () => now,
    observe: () => state,
    settledText: () => reply,
    submit: async p => void submitted.push(p),
    ...over
  }

  return {
    advance(ms: number) {
      now += ms
      vi.advanceTimersByTime(ms)
    },
    deps,
    /** The member answered: the slice gains a message and stops being busy. */
    finish(text: string) {
      reply = text
      state.set({ ...state.get(), busy: false, messages: state.get().messages + 1 })
    },
    /** A HALF-WRITTEN reply: the bubble exists and the turn is still running. */
    stream(text: string) {
      reply = text
      state.set({ ...state.get(), busy: true, messages: state.get().messages + 1 })
    },
    runner: createWebviewRunner(deps),
    state,
    submitted
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the webview runner', () => {
  it('resolves on the slice’s own assistant message — with NO poll', async () => {
    const h = harness()
    const running = h.runner.run(plan, new AbortController().signal)

    await vi.advanceTimersByTimeAsync(0)
    expect(h.submitted).toHaveLength(1)

    h.finish('here is the plan')

    await expect(running).resolves.toEqual({ status: 'reply', text: 'here is the plan' })
  })

  it('does NOT resolve on a half-written reply that is still streaming', async () => {
    // The assistant bubble exists from the first token. Resolving here would
    // post a truncated sentence into the room and hand the NEXT member a prompt
    // built from it.
    const h = harness()
    let settled: unknown = null
    const running = h.runner.run(plan, new AbortController().signal).then(outcome => (settled = outcome))

    await vi.advanceTimersByTimeAsync(0)
    h.stream('here is the pl')
    await vi.advanceTimersByTimeAsync(0)

    expect(settled).toBeNull()

    h.finish('here is the plan')
    await running

    expect(settled).toEqual({ status: 'reply', text: 'here is the plan' })
  })

  it('classifies (pass) as a pass, not a message', async () => {
    const h = harness()
    const running = h.runner.run(plan, new AbortController().signal)

    await vi.advanceTimersByTimeAsync(0)
    h.finish('(pass)')

    await expect(running).resolves.toEqual({ status: 'pass' })
  })

  it('reports a failed submit as a SHAPED error rather than throwing', async () => {
    const h = harness({
      submit: async () => {
        throw new Error('gateway closed')
      }
    })

    await expect(h.runner.run(plan, new AbortController().signal)).resolves.toEqual({
      message: 'gateway closed',
      status: 'error'
    })
  })

  it('strands a silent member once the timeout passes', async () => {
    const h = harness()
    const running = h.runner.run(plan, new AbortController().signal)

    await vi.advanceTimersByTimeAsync(0)
    h.advance(11_000)
    await vi.advanceTimersByTimeAsync(0)

    await expect(running).resolves.toEqual({ status: 'timeout', strandedBefore: 3 })
  })

  it('EXTENDS past the timeout while the member is visibly working', async () => {
    const h = harness()

    h.state.set({ ...h.state.get(), busy: true })

    const running = h.runner.run(plan, new AbortController().signal)

    await vi.advanceTimersByTimeAsync(0)
    h.advance(30_000)
    await vi.advanceTimersByTimeAsync(0)

    // Well past `timeoutMs`, still going: a working member has not failed.
    h.finish('took a while')

    await expect(running).resolves.toEqual({ status: 'reply', text: 'took a while' })
  })

  it('EXTENDS while the member is parked on a question waiting for the USER', async () => {
    const h = harness()

    h.state.set({ ...h.state.get(), awaitingInput: true })

    const running = h.runner.run(plan, new AbortController().signal)

    await vi.advanceTimersByTimeAsync(0)
    h.advance(30_000)
    await vi.advanceTimersByTimeAsync(0)

    h.state.set({ ...h.state.get(), awaitingInput: false })
    h.finish('after you answered')

    await expect(running).resolves.toEqual({ status: 'reply', text: 'after you answered' })
  })

  it('gives up at the HARD CAP even on a member that never stops working', async () => {
    const h = harness()

    h.state.set({ ...h.state.get(), busy: true })

    const running = h.runner.run(plan, new AbortController().signal)

    await vi.advanceTimersByTimeAsync(0)
    h.advance(61_000)
    await vi.advanceTimersByTimeAsync(0)

    await expect(running).resolves.toEqual({ status: 'timeout', strandedBefore: 3 })
  })

  it('abandons on abort, so a superseding send does not leave a listener behind', async () => {
    const h = harness()
    const controller = new AbortController()
    const running = h.runner.run(plan, controller.signal)

    await vi.advanceTimersByTimeAsync(0)
    controller.abort()

    await expect(running).resolves.toEqual({ status: 'superseded' })
    // The subscription is gone: a later slice change resolves nothing new.
    h.finish('too late')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('reports honestly that it does NOT survive suspension', () => {
    // The whole pause contract reads this rather than assuming.
    const { runner } = harness()

    expect(runner.survivesSuspension).toBe(false)
    expect(runner.id).toBe('webview')
  })
})
