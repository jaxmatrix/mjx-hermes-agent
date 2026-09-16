/**
 * The gateway client must OUTLIVE a transport drop (MJXHRM-530, gap G1).
 *
 * This is the failure the design called the highest risk in the unit, because
 * it is invisible: the per-session event `seq` watermarks and the backend's
 * `replay_epoch` live on the CLIENT INSTANCE, and `close()` deliberately keeps
 * them so the next open can ask `session.events.since` for exactly the frames
 * the drop ate. `connectGateway` used to build a brand new client on every dial
 * — so every reconnect started with an empty watermark map, the replay fetch
 * short-circuited on `lastSeenSeq.size === 0`, and NOTHING happened. No error,
 * no warning, and every unit test that did not simulate a real drop still
 * passed while lossless reconnect was dead on the device.
 *
 * So the assertion here is deliberately not "a client exists" or "connect
 * resolved" — both were true of the broken version. It is the wire frame only a
 * surviving watermark can produce: a `session.events.since` carrying the right
 * `last_seen`, sent on the socket that replaced the dropped one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Connection } from '@/store/gateway-config'

/** Every socket the factory has minted, newest last. */
const sockets: FakeSocket[] = []

type Listener = (event: never) => void

/**
 * Stands in for the Rust-backed socket. Opens itself on a microtask, the way
 * the real one reaches `open` from the IPC event, so `connect()` resolves.
 */
class FakeSocket {
  readyState = 0
  sent: string[] = []
  lastErrorDetail: string | undefined
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(readonly url: string) {
    sockets.push(this)
    queueMicrotask(() => this.open())
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()

    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    this.readyState = 3
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event as never)
    }
  }

  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  /** One `event` notification, as the gateway frames it. */
  deliverEvent(sessionId: string, seq: number): void {
    this.emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { payload: {}, seq, session_id: sessionId, type: 'message.delta' }
      })
    })
  }

  /** The socket dying under us — a sleep/wake drop, not a deliberate close. */
  drop(code: number): void {
    this.readyState = 3
    this.emit('close', { code })
  }

  /** The decoded frames this socket was asked to send. */
  frames(): { method?: string; params?: Record<string, unknown> }[] {
    return this.sent.map(text => JSON.parse(text) as { method?: string; params?: Record<string, unknown> })
  }
}

vi.mock('@/transport/tauri-websocket', () => ({ TauriWebSocket: FakeSocket }))
vi.mock('@/store/gateway-config', () => ({ resolveWsUrl: vi.fn(() => Promise.resolve('ws://localhost:1/ws')) }))
vi.mock('@/contrib/events', () => ({ emitGatewayEvent: vi.fn() }))

const { closeGateway, connectGateway, lastGatewayCloseCode } = await import('@/store/gateway')

const CONN: Connection = { authMode: 'none', baseUrl: 'http://localhost:8765', mode: 'remote' }

/** Let the client's fire-and-forget replay fetch reach the socket. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  sockets.length = 0
})

afterEach(() => {
  closeGateway()
})

describe('gateway client lifetime across a transport drop', () => {
  it('asks the gateway to replay from the watermark it held before the drop', async () => {
    await connectGateway(CONN)

    const first = sockets[0]

    // Seeded OUT OF ORDER on purpose: the watermark is the MAXIMUM seq seen,
    // not the last one to arrive. A fixture that only ever counted up would
    // pass against an implementation that simply stored the latest arrival.
    first.deliverEvent('s1', 5)
    first.deliverEvent('s1', 3)

    first.drop(1006)

    await connectGateway(CONN)
    await settle()

    const replay = sockets[1].frames().find(frame => frame.method === 'session.events.since')

    expect(replay, 'no session.events.since was sent — the watermark did not survive the drop').toBeDefined()
    expect(replay?.params).toMatchObject({ last_seen: 5, session_id: 's1' })
  })

  // A second socket, not a reused one: the point is that the CLIENT survives,
  // not the connection. If the dial had somehow reused the dead socket the
  // replay above could pass while the app stayed deaf.
  it('dials a fresh socket for the reconnect', async () => {
    await connectGateway(CONN)
    sockets[0].deliverEvent('s1', 2)
    sockets[0].drop(1006)

    await connectGateway(CONN)

    expect(sockets).toHaveLength(2)
    expect(sockets[1]).not.toBe(sockets[0])
  })

  /**
   * The close code has to outlive the socket: the reconnect supervisor reads it
   * AFTER the close to tell a refused credential (4401/4403 — bounded, then
   * stop) from a dropped connection (retry indefinitely). With it discarded the
   * supervisor retried a dead credential on the unbounded network ladder.
   */
  it('keeps the close code the server sent', async () => {
    await connectGateway(CONN)
    sockets[0].drop(4401)

    expect(lastGatewayCloseCode()).toBe(4401)
  })

  /**
   * A move to a DIFFERENT backend must NOT carry the watermarks over. Seq
   * numbering is per-backend, so replaying from position 5 of the gateway we
   * just left would ask the new one for a position in someone else's
   * numbering.
   */
  it('does not replay a previous gateway’s watermark onto a different backend', async () => {
    await connectGateway(CONN)
    sockets[0].deliverEvent('s1', 5)
    sockets[0].drop(1006)

    await connectGateway({ ...CONN, baseUrl: 'http://other-host:8765' })
    await settle()

    expect(sockets[1].frames().some(frame => frame.method === 'session.events.since')).toBe(false)
  })
})
