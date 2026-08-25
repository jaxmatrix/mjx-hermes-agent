import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { connect, invoke, onAny, request, close: closeClient } = vi.hoisted(() => ({
  close: vi.fn(),
  connect: vi.fn(async () => {}),
  invoke: vi.fn(),
  onAny: vi.fn(),
  request: vi.fn(async () => 'ok')
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/transport/tauri-websocket', () => ({ TauriWebSocket: class {} }))
vi.mock('@/gateway', () => ({
  JsonRpcGatewayClient: class {
    close = closeClient
    connect = connect
    onAny = onAny
    request = request
  }
}))

import {
  __testing,
  addConnectionEventListener,
  closeAllSecondaries,
  IDLE_REAP_MS,
  leaseSecondary,
  MAX_SECONDARIES,
  releaseSecondary
} from './gateway-secondaries'

beforeEach(() => {
  vi.useFakeTimers()
  __testing.reset()

  for (const spy of [connect, invoke, onAny, request, closeClient]) {
    spy.mockClear()
  }

  invoke.mockResolvedValue({ baseUrl: 'https://gw.test' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('leaseSecondary', () => {
  it('reuses one socket per scope', async () => {
    await leaseSecondary('conn:a::default', 'a')
    await leaseSecondary('conn:a::default', 'a')

    expect(connect).toHaveBeenCalledTimes(1)
    expect(__testing.liveScopeKeys()).toEqual(['conn:a::default'])
  })

  it('caps at five and evicts the least recently used', async () => {
    // A 445 room with six members on six profiles of one connection needs FIVE
    // distinct leases (dispatch short-circuits only on the active scope), so a
    // cap of four would evict a member mid-round (reconciliation A11).
    expect(MAX_SECONDARIES).toBe(5)

    for (let n = 0; n < MAX_SECONDARIES; n += 1) {
      await leaseSecondary(`conn:a::p${n}`, 'a')
      vi.advanceTimersByTime(1)
    }

    await leaseSecondary('conn:a::p9', 'a')

    const live = __testing.liveScopeKeys()

    expect(live).toHaveLength(MAX_SECONDARIES)
    expect(live).not.toContain('conn:a::p0')
    expect(live).toContain('conn:a::p9')
  })

  it('reaps an idle socket, because Rust never reconnects one', async () => {
    const lease = await leaseSecondary('conn:a::default', 'a')

    releaseSecondary(lease)
    vi.advanceTimersByTime(IDLE_REAP_MS + 1)

    expect(closeClient).toHaveBeenCalled()
    expect(__testing.liveScopeKeys()).toEqual([])
  })

  it('refuses a source with no addressable URL rather than inventing one', async () => {
    invoke.mockResolvedValue({})

    await expect(leaseSecondary('conn:ssh::default', 'ssh')).rejects.toThrow(/no addressable gateway/)
    expect(__testing.liveScopeKeys()).toEqual([])
  })
})

describe('events', () => {
  it('drops an unclaimed foreign event instead of routing it', async () => {
    await leaseSecondary('conn:a::default', 'a')

    const deliver = onAny.mock.calls[0]?.[0] as (event: unknown) => void

    // Nothing registered for 'a': the event goes nowhere. Handing it to the
    // app's own router would put another machine's session id into the active
    // connection's stores (rule 7).
    expect(() => deliver({ type: 'session.event' })).not.toThrow()

    const seen: unknown[] = []
    const off = addConnectionEventListener('a', event => seen.push(event))

    deliver({ type: 'session.event' })
    expect(seen).toHaveLength(1)
    expect((seen[0] as { connectionId: string }).connectionId).toBe('a')

    off()
    deliver({ type: 'session.event' })
    expect(seen).toHaveLength(1)
  })

  it('survives a listener that throws', async () => {
    await leaseSecondary('conn:a::default', 'a')

    const deliver = onAny.mock.calls[0]?.[0] as (event: unknown) => void
    const seen: unknown[] = []

    addConnectionEventListener('a', () => {
      throw new Error('bad plugin')
    })
    addConnectionEventListener('a', event => seen.push(event))

    deliver({ type: 'session.event' })
    expect(seen).toHaveLength(1)
  })
})

describe('closeAllSecondaries', () => {
  it('drops every socket, because they belong to the source being left', async () => {
    await leaseSecondary('conn:a::default', 'a')
    await leaseSecondary('conn:b::default', 'b')

    closeAllSecondaries()

    expect(__testing.liveScopeKeys()).toEqual([])
    expect(closeClient).toHaveBeenCalledTimes(2)
  })
})
