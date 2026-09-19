import type { WebSocketLike } from '@hermes/shared'

import type { TunnelLease } from '@/store/connection-tunnels'
import { TauriWebSocket } from '@/transport/tauri-websocket'

/**
 * The socket seam under `HermesGateway` (`src/hermes.ts`).
 *
 * Desktop's registry and boot hook dial `gateway.connect(wsUrl)` with a URL the
 * bridge minted, and know nothing else about the connection. Here the socket
 * lives in Rust, which attaches a registered connection's credentials itself
 * (`ws_open`'s `connectionId`), and a local or SSH backend is only reachable
 * while a tunnel lease is held. So whoever mints a URL records what it was
 * minted for, and the factory reads that back by URL at dial time — Electron's
 * `remote-ws-headers.ts`, which remembers upgrade headers by URL the same way.
 */

export interface GatewayMint {
  connectionId: string
  /** Local and SSH: reached through a tunnel the socket holds for its life. */
  tunnel?: boolean
  /** Names the connection in a tunnel sign-in notification. */
  label?: string
}

/** Electron's bound (`createRemoteWsHeaderStore`). */
const MINT_LIMIT = 100

// Keyed by URL, which can carry a single-use ticket: never logged, never exported.
const mints = new Map<string, GatewayMint>()

/**
 * Remember what `wsUrl` was minted for. Every mint of a URL a gateway may dial
 * records it — the connection descriptor's `wsUrl` as much as a fresh re-mint.
 *
 * An entry leaves only as the oldest past {@link MINT_LIMIT}, Electron's rule.
 * Not on dial: a URL is dialled again — a reconnect re-dials the descriptor's
 * own `wsUrl`, and the launch profile's URL is its connection's bare one, which
 * every window on it mints alike — and a dial that took the entry would open
 * the next with no credentials. (Another profile mints a URL of its own:
 * `withSocketProfile`.)
 */
export function recordGatewayMint(wsUrl: string, mint: GatewayMint): void {
  mints.delete(wsUrl)
  mints.set(wsUrl, mint)

  while (mints.size > MINT_LIMIT) {
    mints.delete(mints.keys().next().value as string)
  }
}

function mintFor(wsUrl: string): GatewayMint | undefined {
  const mint = mints.get(wsUrl)

  if (mint) {
    // Most recently dialled is last to go.
    mints.delete(wsUrl)
    mints.set(wsUrl, mint)
  }

  return mint
}

/**
 * `HermesGateway`'s `socketFactory`. A URL nothing minted opens as it always
 * has: whatever auth it carries is in the URL itself.
 */
export function openGatewaySocket(wsUrl: string): WebSocketLike {
  const mint = mintFor(wsUrl)

  if (!mint) {
    return new TauriWebSocket(wsUrl) as unknown as WebSocketLike
  }

  if (!mint.tunnel) {
    return new TauriWebSocket(wsUrl, { connectionId: mint.connectionId }) as unknown as WebSocketLike
  }

  return new TunnelGatewaySocket(wsUrl, mint) as unknown as WebSocketLike
}

type SocketEvent = { type: string; code?: number; data?: unknown; message?: string; reason?: string }
type SocketListener = (event: SocketEvent) => void

/**
 * A gateway socket to a local or SSH connection. It holds one tunnel lease from
 * before it dials until it ends — a server close, an error, a local `close()`,
 * a connect that never opened — and lets go exactly once.
 *
 * An ERROR ends it in two steps, in this order:
 *
 *  1. the inner `error` is forwarded and the lease is let go, at once — a broken
 *     socket holds no tunnel. No `close` is said yet.
 *  2. the transport's own `close` is forwarded WITH ITS CODE. It always follows:
 *     `TauriWebSocket` dispatches it synchronously after a failed open, and
 *     Rust's read loop emits exactly one after an error (`pump_reader`). Saying
 *     a code-less `close` at step 1 would swallow it, and `HermesGateway`'s
 *     `lastCloseCode` is how the supervisor tells a refused credential
 *     (4401/4403) from a drop.
 *
 * A local `close()` between the two says the one `close` itself, code-less —
 * and so does `CLOSE_AFTER_ERROR_MS` running out. "Always follows" is the
 * transport's promise, not this socket's: the shared client learns of a death
 * from `close` alone, and one that never came would leave it never reconnecting.
 *
 * The tunnel moving to a later generation, or no longer serving the lease, ends
 * the socket (`gateway-secondaries.ts`'s rule): the owner's next dial re-mints.
 */
/** How long the transport's `close` may trail its `error`. It is dispatched in
 *  the same turn or the next event; this is only the bound on never. */
const CLOSE_AFTER_ERROR_MS = 2_000

class TunnelGatewaySocket {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState = 0

  private inner: null | TauriWebSocket = null
  private lease: null | TunnelLease = null
  private released = false
  private ended = false
  private closeOverdue: ReturnType<typeof setTimeout> | undefined
  private sendQueue: string[] = []
  private unsubscribe: (() => void)[] = []
  private readonly listeners = new Map<string, Set<SocketListener>>()

  constructor(
    private readonly wsUrl: string,
    private readonly mint: GatewayMint
  ) {
    void this.open()
  }

  private async open(): Promise<void> {
    let lease: TunnelLease

    try {
      // Dynamic: the tunnel store reaches `@/hermes` through `@/i18n`, and this
      // module is imported BY `@/hermes`.
      const { acquireTunnel } = await import('@/store/connection-tunnels')

      lease = await acquireTunnel(this.mint.connectionId, { label: this.mint.label })
    } catch {
      // The tunnel's own error can name the host; the client reports its own.
      this.dispatch({ message: 'tunnel unavailable', type: 'error' })
      this.end()

      return
    }

    if (this.ended) {
      // Closed while the tunnel was still dialling.
      lease.release()

      return
    }

    this.lease = lease

    const dialled = lease.generation()

    this.unsubscribe.push(
      // Only a LATER generation: the event for the dial this socket rides can
      // land after it.
      lease.onChange(next => {
        if (next.generation > dialled) {
          this.end()
        }
      }),
      lease.onClosed(() => this.end())
    )

    // The lease's base read at dial time: a redial since the mint moved the port.
    const inner = new TauriWebSocket(`${lease.wsUrl()}${new URL(this.wsUrl).search}`, {
      connectionId: this.mint.connectionId
    })

    this.inner = inner

    inner.addEventListener('open', event => {
      this.readyState = this.OPEN
      this.dispatch(event)
    })
    inner.addEventListener('message', event => this.dispatch(event))
    inner.addEventListener('error', event => {
      this.dispatch(event)

      if (!this.ended) {
        this.readyState = this.CLOSING
        this.letGo()
        this.closeOverdue ??= setTimeout(() => this.end(), CLOSE_AFTER_ERROR_MS)
      }
    })
    inner.addEventListener('close', event => this.end(event))

    for (const text of this.sendQueue.splice(0)) {
      inner.send(text)
    }
  }

  /** Let go of the tunnel: once, at whichever ending comes first. */
  private letGo(): void {
    if (this.released) {
      return
    }

    this.released = true

    for (const off of this.unsubscribe.splice(0)) {
      off()
    }

    this.lease?.release()
    this.lease = null
  }

  /** The one way out: closes the socket, releases the lease, says `close`. */
  private end(event: SocketEvent = { type: 'close' }): void {
    if (this.ended) {
      return
    }

    this.ended = true
    this.readyState = this.CLOSED
    clearTimeout(this.closeOverdue)
    this.letGo()
    this.inner?.close()
    this.dispatch(event)
  }

  private dispatch(event: SocketEvent): void {
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) {
      handler(event)
    }
  }

  addEventListener(type: string, handler: SocketListener): void {
    const set = this.listeners.get(type) ?? new Set()

    set.add(handler)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, handler: SocketListener): void {
    this.listeners.get(type)?.delete(handler)
  }

  send(text: string): void {
    if (this.inner) {
      this.inner.send(text)
    } else if (!this.ended) {
      this.sendQueue.push(text)
    }
  }

  close(): void {
    this.end()
  }
}

export const __testing = {
  mintCount: (): number => mints.size,
  reset(): void {
    mints.clear()
  }
}
