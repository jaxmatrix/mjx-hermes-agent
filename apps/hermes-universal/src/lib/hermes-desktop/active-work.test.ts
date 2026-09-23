import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][]
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])
  })
}))

import { activeWorkBridge } from './active-work'

beforeEach(() => {
  native.calls = []
})

describe('hermesDesktop.setActiveWork', () => {
  it('fire-and-forgets the Rust command with Electron’s payload shape', async () => {
    activeWorkBridge.setActiveWork!({ count: 1, titles: ['Fix login'] })

    await vi.waitFor(() => {
      expect(native.calls).toEqual([
        ['set_active_work', { payload: { count: 1, titles: ['Fix login'] } }]
      ])
    })
  })
})
