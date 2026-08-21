/**
 * The controller is the only thing standing between "user double-taps Trigger
 * now" and two live fires of the same cron job from one surface. Every case
 * here seeds a controller that is NOT running the key, so the assertion can
 * only pass if `run` itself flipped the guard.
 */

import { describe, expect, it, vi } from 'vitest'

import { createCronTriggerController } from './cron-trigger-controller'

/** A promise plus the handles to settle it — lets a test hold `run` open. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, reject, resolve }
}

describe('createCronTriggerController', () => {
  it('refuses a second run of the same key while the first is in flight', async () => {
    const controller = createCronTriggerController()
    const gate = deferred<string>()
    const action = vi.fn(() => gate.promise)

    // Disagreeing fixture: nothing is running yet, so a broken guard would let
    // BOTH calls through and this would read started:true twice.
    expect(controller.isRunning('job-1')).toBe(false)

    const first = controller.run('job-1', action)
    const second = await controller.run('job-1', action)

    expect(second).toEqual({ started: false, value: null })
    // The rejected call must never have reached the action at all — a guard
    // that only discarded the RESULT would still have fired the job twice.
    expect(action).toHaveBeenCalledTimes(1)

    gate.resolve('fired')
    expect(await first).toEqual({ started: true, value: 'fired' })
  })

  it('reports isRunning true only while the action is in flight', async () => {
    const controller = createCronTriggerController()
    const gate = deferred<null>()

    const inFlight = controller.run('job-1', () => gate.promise)

    expect(controller.isRunning('job-1')).toBe(true)

    gate.resolve(null)
    await inFlight

    expect(controller.isRunning('job-1')).toBe(false)
  })

  it('runs different keys concurrently', async () => {
    const controller = createCronTriggerController()
    const gate = deferred<string>()

    const first = controller.run('job-1', () => gate.promise)
    const second = await controller.run('job-2', async () => 'b')

    expect(second).toEqual({ started: true, value: 'b' })

    gate.resolve('a')
    expect(await first).toEqual({ started: true, value: 'a' })
  })

  it('releases the key when the action throws, and rethrows', async () => {
    const controller = createCronTriggerController()
    const boom = new Error('gateway unreachable')

    await expect(controller.run('job-1', () => Promise.reject(boom))).rejects.toBe(boom)

    // A `finally`-less release would leave the key latched forever, so the row's
    // Trigger button would be dead until remount — the failure mode this guards.
    expect(controller.isRunning('job-1')).toBe(false)
    expect(await controller.run('job-1', async () => 'retried')).toEqual({ started: true, value: 'retried' })
  })

  it('publishes running true then false, and calls onStarted once', async () => {
    const changes: [string, boolean][] = []
    const controller = createCronTriggerController((key, running) => changes.push([key, running]))
    const onStarted = vi.fn()

    await controller.run('job-1', async () => 'ok', onStarted)

    expect(changes).toEqual([
      ['job-1', true],
      ['job-1', false]
    ])
    expect(onStarted).toHaveBeenCalledTimes(1)
  })

  it('does not publish or call onStarted for a refused run', async () => {
    const changes: [string, boolean][] = []
    const controller = createCronTriggerController((key, running) => changes.push([key, running]))
    const gate = deferred<null>()
    const onStarted = vi.fn()

    const first = controller.run('job-1', () => gate.promise)
    await controller.run('job-1', async () => null, onStarted)

    // The refused call must be silent: a second `true` here would flip the row's
    // pending spinner on for a fire that never happened.
    expect(changes).toEqual([['job-1', true]])
    expect(onStarted).not.toHaveBeenCalled()

    gate.resolve(null)
    await first
  })
})
