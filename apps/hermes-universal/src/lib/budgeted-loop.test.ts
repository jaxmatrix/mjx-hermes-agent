/**
 * The bug class this helper exists to end: a decorative rAF loop that never
 * sleeps. Universal shipped exactly one of them (the pet sprite), which painted
 * flat out with no visibility check at all, so a minimized window kept drawing.
 * Ported alongside desktop's `lib/budgeted-loop.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBudgetedLoop } from './budgeted-loop'

let callbacks: Map<number, FrameRequestCallback>
let nextHandle = 1

/** Run one frame stamped `at`, the way rAF would. The loop reads only the
 *  timestamp its callback is handed, so there is no clock to advance here. */
function frame(at: number) {
  const pending = [...callbacks.entries()]
  callbacks.clear()

  for (const [, cb] of pending) {
    cb(at)
  }
}

beforeEach(() => {
  nextHandle = 1
  callbacks = new Map()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const handle = nextHandle++
    callbacks.set(handle, cb)

    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => callbacks.delete(handle))
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createBudgetedLoop', () => {
  it('skips a frame that arrives inside the fps budget', () => {
    const draw = vi.fn()
    const loop = createBudgetedLoop(draw, { fps: 10 })

    frame(0)
    // 50ms later: inside the 100ms budget, so this frame must not paint.
    frame(50)

    expect(draw).toHaveBeenCalledTimes(1)
    loop.dispose()
  })

  it('paints once the budget has elapsed', () => {
    const draw = vi.fn()
    const loop = createBudgetedLoop(draw, { fps: 10 })

    frame(0)
    frame(150)

    expect(draw).toHaveBeenCalledTimes(2)
    loop.dispose()
  })

  it('stops painting while the document is hidden', () => {
    const draw = vi.fn()
    const loop = createBudgetedLoop(draw, { fps: 60 })

    frame(0)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    draw.mockClear()

    frame(1000)

    expect(draw).not.toHaveBeenCalled()
    loop.dispose()
  })

  it('resumes when the document becomes visible again', () => {
    const draw = vi.fn()
    const loop = createBudgetedLoop(draw, { fps: 60 })
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')

    document.dispatchEvent(new Event('visibilitychange'))
    hidden.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    draw.mockClear()

    frame(1000)

    expect(draw).toHaveBeenCalled()
    loop.dispose()
  })

  it('keeps running while merely unfocused when pauseWhenUnfocused is false', () => {
    const draw = vi.fn()
    const loop = createBudgetedLoop(draw, { fps: 60, pauseWhenUnfocused: false })

    window.dispatchEvent(new Event('blur'))
    draw.mockClear()
    frame(1000)

    expect(draw).toHaveBeenCalled()
    loop.dispose()
  })

  it('pauses on blur by default', () => {
    const draw = vi.fn()
    const loop = createBudgetedLoop(draw, { fps: 60 })

    window.dispatchEvent(new Event('blur'))
    draw.mockClear()
    frame(1000)

    expect(draw).not.toHaveBeenCalled()
    loop.dispose()
  })

  it('parks with zero pending frames when there is nothing to animate', () => {
    const loop = createBudgetedLoop(() => {}, { fps: 60, idleWhen: () => true })

    frame(0)

    expect(loop.isDormant()).toBe(true)
    expect(callbacks.size).toBe(0)
    loop.dispose()
  })

  it('wake() restarts a parked loop', () => {
    const draw = vi.fn()
    const loop = createBudgetedLoop(draw, { fps: 60, idleWhen: () => true })

    frame(0)
    draw.mockClear()
    loop.wake()
    frame(1000)

    expect(draw).toHaveBeenCalled()
    loop.dispose()
  })

  it('dispose() stops the loop and makes wake() a no-op', () => {
    const draw = vi.fn()
    const loop = createBudgetedLoop(draw, { fps: 60 })

    frame(0)
    loop.dispose()
    draw.mockClear()
    loop.wake()
    frame(1000)

    expect(draw).not.toHaveBeenCalled()
    expect(callbacks.size).toBe(0)
  })
})
