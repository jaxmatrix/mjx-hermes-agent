import { beforeEach, describe, expect, it, vi } from 'vitest'

const active = vi.hoisted(() => ({ kind: null as null | string }))
const restart = vi.hoisted(() => vi.fn(async () => true))

vi.mock('@/store/active-connection', () => ({
  $activeConnection: { get: () => (active.kind ? { connectionId: 'c', kind: active.kind } : null) }
}))
vi.mock('@/store/profile-chat-scope', () => ({ restartLocalBackendConfirmed: restart }))

import { backendBridge as bridge } from './backend'
import { onConnectionApplied } from './connection-applied'

const applied = vi.fn()

onConnectionApplied(applied)

beforeEach(() => {
  vi.clearAllMocks()
  active.kind = null
})

describe('revalidateConnection', () => {
  it('has no cached descriptor to drop, and says so', async () => {
    expect(await bridge.revalidateConnection()).toEqual({ ok: true, rebuilt: false })
  })
})

describe('recycleBackend', () => {
  it('respawns this device’s backend, asking first when it is busy', async () => {
    active.kind = 'local'

    expect(await bridge.recycleBackend('default')).toEqual({ ok: true })
    expect(restart).toHaveBeenCalledOnce()
    expect(applied).not.toHaveBeenCalled()
  })

  it.each(['remote', 'cloud'])('re-dials a %s source, which is not ours to restart', async kind => {
    active.kind = kind

    expect(await bridge.recycleBackend()).toEqual({ ok: true })
    expect(applied).toHaveBeenCalledOnce()
    expect(restart).not.toHaveBeenCalled()
  })

  it('refuses an SSH source rather than claim a restart it cannot make', async () => {
    active.kind = 'ssh'

    await expect(bridge.recycleBackend()).rejects.toThrow('cannot be restarted from here')
    expect(applied).not.toHaveBeenCalled()
  })

  it('does nothing with no connection', async () => {
    expect(await bridge.recycleBackend()).toEqual({ ok: true })
    expect(restart).not.toHaveBeenCalled()
    expect(applied).not.toHaveBeenCalled()
  })
})
