/**
 * The primitive's whole reason to exist is that BOTH halves of the teardown
 * happen, on every way a drag can end. So the assertion here is not "onMove
 * stopped firing" — a handler can stop reacting while its listener is still
 * registered, and that is exactly the leak. A tracker mirrors window's
 * listener table (type + function identity + capture flag, the triple
 * `removeEventListener` actually matches on) and the tests assert it is empty.
 *
 * That triple matters: removing with the wrong capture flag is a silent no-op
 * in the DOM, so a version that adds with `true` and removes without it would
 * still "look" torn down to a call-count spy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startPointerDrag } from './pointer-drag'

interface LiveListener {
  capture: boolean
  fn: unknown
  type: string
}

let live: LiveListener[] = []
let restore: () => void

const captureOf = (options?: AddEventListenerOptions | boolean | EventListenerOptions) =>
  typeof options === 'boolean' ? options : !!options?.capture

/** Every pointer listener still registered on window. */
const livePointer = () => live.filter(entry => entry.type.startsWith('pointer'))

beforeEach(() => {
  live = []

  const add = window.addEventListener.bind(window)
  const remove = window.removeEventListener.bind(window)

  window.addEventListener = ((type: string, fn: unknown, options?: AddEventListenerOptions | boolean) => {
    live.push({ capture: captureOf(options), fn, type })

    return add(type as keyof WindowEventMap, fn as EventListener, options)
  }) as typeof window.addEventListener

  window.removeEventListener = ((type: string, fn: unknown, options?: AddEventListenerOptions | boolean) => {
    const at = live.findIndex(entry => entry.type === type && entry.fn === fn && entry.capture === captureOf(options))

    if (at >= 0) {
      live.splice(at, 1)
    }

    return remove(type as keyof WindowEventMap, fn as EventListener, options)
  }) as typeof window.removeEventListener

  restore = () => {
    window.addEventListener = add
    window.removeEventListener = remove
  }
})

afterEach(() => {
  restore()
})

/** jsdom has no PointerEvent; MouseEvent is what the app's own tests use. */
const firePointer = (type: string, clientX = 0) =>
  window.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }))

describe('startPointerDrag', () => {
  it('tracks movement while the drag runs', () => {
    const onMove = vi.fn()
    startPointerDrag(onMove)

    // Seeded to disagree with "torn down": the listener must be LIVE here, or
    // the teardown assertions below would pass on a primitive that never
    // bound anything at all.
    expect(livePointer()).toHaveLength(3)

    firePointer('pointermove', 40)
    firePointer('pointermove', 80)

    expect(onMove).toHaveBeenCalledTimes(2)
    expect(onMove.mock.calls[1][0]).toMatchObject({ clientX: 80 })
  })

  it('unbinds every listener on pointerup and calls onEnd once', () => {
    const onMove = vi.fn()
    const onEnd = vi.fn()
    startPointerDrag(onMove, onEnd)

    firePointer('pointerup')

    expect(livePointer()).toHaveLength(0)
    expect(onEnd).toHaveBeenCalledTimes(1)

    firePointer('pointermove', 120)
    firePointer('pointerup')

    expect(onMove).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('unbinds every listener on pointercancel — the touch path desktop does not have', () => {
    const onMove = vi.fn()
    const onEnd = vi.fn()
    startPointerDrag(onMove, onEnd)

    firePointer('pointercancel')

    expect(livePointer()).toHaveLength(0)
    expect(onEnd).toHaveBeenCalledTimes(1)

    firePointer('pointermove', 200)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('unbinds every listener when the caller cancels mid-drag (unmount)', () => {
    const onMove = vi.fn()
    const onEnd = vi.fn()
    const cancel = startPointerDrag(onMove, onEnd)

    firePointer('pointermove', 30)
    expect(onMove).toHaveBeenCalledTimes(1)

    cancel()

    expect(livePointer()).toHaveLength(0)
    // An unmount is not an end: nothing committed the drag, so onEnd must not
    // fire and write a value for a component that no longer exists.
    expect(onEnd).not.toHaveBeenCalled()

    firePointer('pointermove', 60)
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — cancelling after the drag already ended is a no-op', () => {
    const onEnd = vi.fn()
    const cancel = startPointerDrag(vi.fn(), onEnd)

    firePointer('pointerup')
    cancel()
    cancel()

    expect(livePointer()).toHaveLength(0)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('keeps concurrent drags independent', () => {
    const first = vi.fn()
    const second = vi.fn()
    startPointerDrag(first)
    const cancelSecond = startPointerDrag(second)

    expect(livePointer()).toHaveLength(6)

    cancelSecond()

    expect(livePointer()).toHaveLength(3)

    firePointer('pointermove', 10)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })
})
