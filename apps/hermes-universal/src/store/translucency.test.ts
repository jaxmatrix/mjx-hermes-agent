/**
 * The intensity slider fires an update per tick of the drag, and each one used
 * to be an IPC wake into Rust. `window-vibrancy` animates the material over
 * ~150ms, so re-issuing the call per tick restarts that animation before it can
 * settle: the drag is janky AND the frost levels look identical, because they
 * never finish. Ported from desktop f3bfa9ae53 (renderer half).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'

const invoke = vi.fn().mockResolvedValue(undefined)

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  IS_DESKTOP: true
}))

import { $translucency, flushPendingTranslucency, setTranslucency } from '@/store/translucency'

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockClear()
  $translucency.set(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('setTranslucency', () => {
  it('sends ONE native call for a six-tick drag, not six', async () => {
    for (const value of [5, 10, 15, 20, 25, 30]) {
      setTranslucency(value)
    }

    expect(invoke).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()

    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('sends the value the drag ENDED on', async () => {
    setTranslucency(5)
    setTranslucency(90)
    await vi.runAllTimersAsync()

    expect(invoke).toHaveBeenCalledWith('set_window_translucency', { intensity: 90 })
  })

  it('moves the persisted value on every tick, so the field tracks the hand', () => {
    setTranslucency(5)
    setTranslucency(40)

    expect($translucency.get()).toBe(40)
  })

  it('clamps and rounds before persisting', () => {
    setTranslucency(140.6)

    expect($translucency.get()).toBe(100)
  })

  it('flushes a pending change rather than losing it', async () => {
    setTranslucency(42)
    flushPendingTranslucency()
    // `applyTranslucency` reaches Tauri through a dynamic import, so the call
    // lands a microtask after the flush.
    await vi.advanceTimersByTimeAsync(1)

    expect(invoke).toHaveBeenCalledWith('set_window_translucency', { intensity: 42 })
  })

  it('is a no-op to flush when nothing is pending', async () => {
    flushPendingTranslucency()
    // `applyTranslucency` reaches Tauri through a dynamic import, so the call
    // lands a microtask after the flush.
    await vi.advanceTimersByTimeAsync(1)

    expect(invoke).not.toHaveBeenCalled()
  })
})
