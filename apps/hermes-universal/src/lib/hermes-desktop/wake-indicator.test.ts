import { beforeEach, describe, expect, it, vi } from 'vitest'

const bus = vi.hoisted(() => ({
  hello: 0,
  listeners: new Set<(payload: unknown) => void>(),
  offs: 0
}))

vi.mock('@/app/wake-indicator/channel', () => ({
  emitWakeIndicatorHello: vi.fn(async () => void (bus.hello += 1)),
  onWakeIndicatorState: vi.fn(async (handler: (payload: unknown) => void) => {
    bus.listeners.add(handler)

    return () => {
      bus.offs += 1
      bus.listeners.delete(handler)
    }
  })
}))

import { $wakeIndicator } from '@/store/wake-indicator'

import { wakeIndicatorBridge } from './wake-indicator'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  bus.hello = 0
  bus.offs = 0
  bus.listeners.clear()
  $wakeIndicator.set('hidden')
})

describe('hermesDesktop.wakeIndicator', () => {
  // Every call site guards the namespace and then calls a member bare.
  it('is the whole namespace desktop calls', () => {
    expect(Object.keys(wakeIndicatorBridge).sort()).toEqual(['getState', 'onState', 'setState'])
  })

  it('setState is the writer of the atom both lights read', async () => {
    const seen: string[] = []
    const off = $wakeIndicator.listen(state => void seen.push(state))

    wakeIndicatorBridge.setState('detected')
    wakeIndicatorBridge.setState('detected')
    wakeIndicatorBridge.setState('capturing')
    wakeIndicatorBridge.setState('nonsense' as never)
    wakeIndicatorBridge.setState('hidden')
    off()

    expect(seen).toEqual(['detected', 'capturing', 'hidden'])
    await expect(wakeIndicatorBridge.getState()).resolves.toBe('hidden')
  })

  it('onState hears the driver, and says hello so the driver repeats what it already sent', async () => {
    const heard: string[] = []
    const off = wakeIndicatorBridge.onState(state => void heard.push(state))

    await flush()
    expect(bus.hello).toBe(1)

    bus.listeners.forEach(listener => listener('detected'))
    bus.listeners.forEach(listener => listener({ not: 'a state' }))
    bus.listeners.forEach(listener => listener('capturing'))

    expect(heard).toEqual(['detected', 'capturing'])
    await expect(wakeIndicatorBridge.getState()).resolves.toBe('capturing')

    off()
    expect(bus.offs).toBe(1)
  })

  it('an unsubscribe that beats the subscription still ends it, without a hello', async () => {
    const heard: string[] = []

    wakeIndicatorBridge.onState(state => void heard.push(state))()
    await flush()

    expect(bus.offs).toBe(1)
    expect(bus.hello).toBe(0)
    expect(heard).toEqual([])
  })
})
