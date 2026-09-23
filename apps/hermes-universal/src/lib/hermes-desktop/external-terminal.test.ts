import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][]
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])
    return { ok: true }
  })
}))

import { externalTerminalBridge } from './external-terminal'

beforeEach(() => {
  native.calls = []
})

describe('hermesDesktop.openSessionInTerminal', () => {
  it('invokes Rust with session id and opts', async () => {
    await expect(
      externalTerminalBridge.openSessionInTerminal('sess-1', { cwd: '/proj', profile: 'work' })
    ).resolves.toEqual({ ok: true })

    expect(native.calls).toEqual([
      ['open_session_in_terminal', { sessionId: 'sess-1', opts: { cwd: '/proj', profile: 'work' } }]
    ])
  })
})
