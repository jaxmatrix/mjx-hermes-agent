import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  answer: (async (on: boolean) => on) as (on: boolean) => Promise<boolean>,
  asked: [] as boolean[]
}))

const setKeepAwakeStore = vi.hoisted(() => vi.fn())
const notifyError = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_command: string, args: { on: boolean }) => {
    native.asked.push(args.on)

    return native.answer(args.on)
  })
}))
vi.mock('@/store/keep-awake', () => ({ setKeepAwake: setKeepAwakeStore }))
vi.mock('@/store/notifications', () => ({ notifyError }))

import { powerBridge } from './power'

const flush = () => new Promise(resolve => setTimeout(resolve, 50))

beforeEach(() => {
  native.answer = async on => on
  native.asked = []
  setKeepAwakeStore.mockClear()
  notifyError.mockClear()
})

describe('hermesDesktop.setKeepAwake', () => {
  it('mirrors the switch down to Rust’s inhibitor and returns nothing', async () => {
    expect(powerBridge.setKeepAwake!(true)).toBeUndefined()
    await vi.waitFor(() => expect(native.asked).toEqual([true]))
    powerBridge.setKeepAwake!(false)

    await vi.waitFor(() => expect(native.asked).toEqual([true, false]))
    expect(setKeepAwakeStore).not.toHaveBeenCalled()
  })

  it('turns the switch back off, and says so, when the OS refuses the inhibitor', async () => {
    native.answer = async () => {
      throw new Error('no logind')
    }

    powerBridge.setKeepAwake!(true)

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledOnce())
    expect(setKeepAwakeStore).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('treats "not held" as a refusal too', async () => {
    native.answer = async () => false

    powerBridge.setKeepAwake!(true)

    await vi.waitFor(() => expect(setKeepAwakeStore).toHaveBeenCalledExactlyOnceWith(false))
  })

  it('never corrects a release, so the two cannot bounce', async () => {
    native.answer = async () => {
      throw new Error('unsupported_platform')
    }

    powerBridge.setKeepAwake!(false)
    await flush()

    expect(setKeepAwakeStore).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })
})
