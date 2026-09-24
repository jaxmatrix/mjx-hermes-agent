/**
 * OWNING CLIENTS — one socket per connection, owned by the tabs bound to it
 * (MJXHRM-591).
 *
 * A tab bound to a background connection has to stream, not just ask questions,
 * and `gateway-secondaries` was built for the opposite case: request-only
 * sockets, capped at five, reaped after a minute idle, with every event dropped
 * because nothing listens. This module is the other half of that machine rather
 * than a second one — it PINS a scope (exempt from the cap and the reap, kept
 * across a switch) and registers the listener that carries its frames into the
 * ordinary event router, scoped by the connection that delivered them.
 *
 * The rules, and why:
 *
 *  * ONE socket per CONNECTION (invariant 32, Design v1.3 N2) — not per
 *    connection+profile. The backend serves every profile over one socket
 *    (592's unified mode) and a cross-profile call already names `profile` on
 *    the request, so a second socket for a second profile would be a second
 *    stream of the same events and a second tunnel hold.
 *  * PINNED means never evicted and never reaped (invariant 33). Evicting the
 *    socket a visible tab streams on is the failure `gateway-secondaries`'
 *    header warns about, one rung worse; the cap goes on governing request-only
 *    sockets, and owning clients are bounded by "connections with an open tab".
 *  * The LAST tab closing DEMOTES, it does not kill (invariant 34). The socket
 *    becomes request-only and leaves on the existing 60 s idle reap, so
 *    reopening a tab inside that window is warm. An immediate close is only for
 *    a connection that was removed or edited, and for quit.
 *
 * WHO holds: the tab RECORD (invariant 47). `holdConnectionClient` hands back an
 * opaque {@link ClientHold} and the tab stores keep it beside the record that
 * earned it, released by the same diff that took it — so "how many tabs want
 * this connection" is never a number anybody increments.
 *
 * And it never asks who is ACTIVE (invariant 46): the caller passes `ambient`,
 * because the one caller that is not a tab — the switch's hand-over — runs at
 * the moment when the connection it is handing over is still the active one.
 */

import type { GatewayEvent } from '@/gateway'
import { backendScopeKey } from '@/lib/backend-scope'
import { reconnectBackoffDelayMs } from '@/lib/reconnect-backoff'
import { $activeConnection } from '@/store/active-connection'
import { atom } from '@/store/atom'
import { isTunnelSignInError, needsInteraction } from '@/store/connection-tunnels'
import {
  addConnectionEventListener,
  leaseSecondary,
  pinSecondary,
  setPinnedSecondaryClosedListener,
  unpinSecondary
} from '@/store/gateway-secondaries'
import {
  commitReplayCursor,
  connectionEpoch,
  planReplay,
  readEventsSince,
  type SessionEventsSince
} from '@/store/session-replay'
import { $sessionKeyStates, DEFAULT_SESSION_PROFILE } from '@/store/session-state-types'

/** What a tab's work goes through. */
export type ConnectionClient =
  /** The app's own socket: the tab is on the active connection. */
  | { kind: 'ambient' }
  /** This connection's own socket, held for as long as a tab needs it. */
  | { connectionId: string; kind: 'owning'; scopeKey: string }

/**
 * What a tab on this connection can say about its socket.
 *
 *  * `opening` — the first dial, or a reconnect in flight. A cold SSH dial is
 *    45-90 s, so this is a real state and not a flicker.
 *  * `live` — frames are arriving.
 *  * `degraded` — the socket went away and the ladder is climbing. The tabs
 *    KEEP their slices and their runtime ids: that is what makes replay
 *    possible when it comes back.
 *  * `lost` — terminal. A tunnel that needs a sign-in or an interaction will
 *    not come back by being retried, so the ladder stops and the surface offers
 *    Connect instead of spinning (592's `isTunnelSignInError` / `needsInteraction`).
 */
export type ConnectionClientPhase = 'degraded' | 'live' | 'lost' | 'opening'

export interface ConnectionClientState {
  /** Which rung of the backoff ladder we are on; 0 while live. */
  attempt: number
  /** Why it is lost, for the error box. */
  error?: string
  phase: ConnectionClientPhase
  /** A terminal failure: retrying cannot fix it, the user must act. */
  terminal?: boolean
}

/** Per connection, for the tabs bound to it. The UI reads this; nothing else
 *  in the store layer branches on it. */
export const $connectionClients = atom<Record<string, ConnectionClientState>>({})

/**
 * A HOLD on a connection's client — opaque, and the only thing that keeps one
 * open (Design v1.3, B3).
 *
 * Branded so it cannot be forged or counted: the tab store files it beside the
 * record that earned it, and hands it back when that record leaves the held set.
 */
declare const holdBrand: unique symbol

export interface ClientHold {
  readonly [holdBrand]: true
  readonly connectionId: string
}

interface Hold {
  /** Which rung the ladder is on. */
  attempt: number
  connectionId: string
  /** The open in flight, if any — so two tabs binding at once share it. */
  opening: null | Promise<void>
  /** The backoff timer, while the ladder is climbing. */
  retry: null | ReturnType<typeof setTimeout>
  scopeKey: string
  /** Live holds. The socket lives while it is > 0. */
  holders: number
  /** Undoes the event listener, so a demoted client stops routing frames. */
  unlisten: null | (() => void)
}

const holds = new Map<string, Hold>()

/** How a frame from a connection's own socket reaches the app. Registered by the
 *  owning client alone: `deliver()` drops anything nobody claims (rule 7). */
let sink: ((event: GatewayEvent) => void) | null = null

export function setConnectionEventSink(next: (event: GatewayEvent) => void): void {
  sink = next
}

/**
 * The pool key for a connection's ONE socket (Design v1.3, N2).
 *
 * Per connection, not per connection+profile: `connections_resolve` is already
 * called with `profile: null`, so the socket was never profile-specific — only
 * its pool key was, which made two profiles of one connection open two.
 */
export const connectionScopeKey = (connectionId: string): string =>
  backendScopeKey(connectionId, DEFAULT_SESSION_PROFILE)

/** Whether `connectionId` is the one the app itself is pointed at. For a TAB,
 *  which may ask; the hand-over passes its own answer instead (invariant 46). */
export function isAmbientConnection(connectionId: string): boolean {
  return $activeConnection.get()?.connectionId === connectionId
}

/**
 * The client a tab on `connectionId` works through.
 *
 * A tab on the ACTIVE connection opens nothing: `ambient` names the socket the
 * app already holds. Every other connection gets exactly one owning client,
 * whether one tab uses it or six.
 */
export function clientFor(connectionId: string): ConnectionClient {
  if (isAmbientConnection(connectionId)) {
    return { kind: 'ambient' }
  }

  return { connectionId, kind: 'owning', scopeKey: connectionScopeKey(connectionId) }
}

function setPhase(connectionId: string, hold: Hold, state: ConnectionClientState): void {
  // IDENTITY FIRST (Design v1.3, N3): a settle from a dial whose hold has since
  // been released — or replaced by a later one — must not publish a phase that
  // outlives it, leaving a banner for a connection nothing is holding.
  if (holds.get(connectionId) !== hold) {
    return
  }

  $connectionClients.set({ ...$connectionClients.get(), [connectionId]: state })
}

function clearPhase(connectionId: string): void {
  const { [connectionId]: _gone, ...rest } = $connectionClients.get()

  $connectionClients.set(rest)
}

/** The phase a tab should render. A tab on the active connection rides the
 *  ambient socket, whose state the app already shows. */
export function connectionClientState(connectionId: string): ConnectionClientState | undefined {
  return $connectionClients.get()[connectionId]
}

/**
 * A tab bound to `connectionId` wants its client.
 *
 * `ambient` is the CALLER's answer to "is this the connection the app is on?" —
 * never a read of the active connection (invariant 46). A tab asks the store;
 * the switch's hand-over passes `false` for the connection it is handing over,
 * because at that moment that connection is still the active one and a
 * short-circuit would hand it nothing.
 *
 * The first hold on a connection pins its scope and opens its socket; later
 * holds share it, including one taken while the first is still opening (a cold
 * SSH dial is 45-90 s, and two tabs restored together must not start two dials).
 */
export function holdConnectionClient(connectionId: string, options: { ambient: boolean }): ClientHold | null {
  if (options.ambient) {
    return null
  }

  const existing = holds.get(connectionId)

  if (existing) {
    existing.holders += 1

    return { connectionId } as ClientHold
  }

  const hold: Hold = {
    attempt: 0,
    connectionId,
    holders: 1,
    opening: null,
    retry: null,
    scopeKey: connectionScopeKey(connectionId),
    unlisten: null
  }

  holds.set(connectionId, hold)
  // BEFORE the open: a pin taken while the socket is still opening survives it,
  // so a slow dial cannot be evicted by an unrelated request-only lease landing
  // in the meantime.
  pinSecondary(hold.scopeKey)

  hold.unlisten = addConnectionEventListener(connectionId, event => sink?.(event))
  hold.opening = dial(hold)

  return { connectionId } as ClientHold
}

/**
 * Give a hold back.
 *
 * The last one DEMOTES the socket to request-only: it stops routing frames (no
 * tab is listening) and joins the ordinary idle reap, so a reopen inside the
 * minute finds it warm. It is not closed here — that is a connection being
 * removed or edited, or quit.
 */
export function releaseConnectionClient(hold: ClientHold | null | undefined): void {
  if (!hold) {
    return
  }

  const live = holds.get(hold.connectionId)

  if (!live) {
    return
  }

  live.holders -= 1

  if (live.holders > 0) {
    return
  }

  holds.delete(hold.connectionId)
  live.unlisten?.()
  live.unlisten = null

  if (live.retry) {
    clearTimeout(live.retry)
    live.retry = null
  }

  clearPhase(hold.connectionId)
  unpinSecondary(live.scopeKey)
  // …and the stream bookkeeping the router kept for it (Design v1.3, N10): a
  // connection nothing holds has no stream to pin.
  forgetStream?.(hold.connectionId)
}

/** How the router forgets a connection's unscoped-stream pin. Injected, because
 *  the router imports this module rather than the other way round. */
let forgetStream: null | ((connectionId: string) => void) = null

export function setConnectionStreamReset(reset: (connectionId: string) => void): void {
  forgetStream = reset
}

/**
 * Open (or re-open) a hold's socket, and catch its bound sessions up.
 *
 * The ladder lives here rather than in `gateway-secondaries`, which
 * deliberately never reconnects anything (rule 6: a background retry against
 * four gateways exhausts their descriptors). What makes retrying right HERE is
 * the pin: a tab is on screen, streaming, and the alternative to climbing is a
 * chat that silently stops.
 */
function dial(hold: Hold): Promise<void> {
  setPhase(hold.connectionId, hold, { attempt: hold.attempt, phase: 'opening' })

  const open = leaseSecondary(hold.scopeKey, hold.connectionId)
    .then(async () => {
      hold.attempt = 0
      setPhase(hold.connectionId, hold, { attempt: 0, phase: 'live' })
      await catchUp(hold)
    })
    .catch((error: unknown) => {
      // A tunnel that needs a credential or a prompt will not come back by
      // being retried: stop the ladder and let the surface offer Connect.
      const terminal = isTunnelSignInError(error) || needsInteraction((error as { status?: never })?.status)

      setPhase(hold.connectionId, hold, {
        attempt: hold.attempt,
        error: error instanceof Error ? error.message : String(error),
        phase: terminal ? 'lost' : 'degraded',
        terminal
      })

      if (!terminal) {
        scheduleRetry(hold)
      }
    })
    .finally(() => {
      hold.opening = null
    })

  return open
}

/** Climb one rung, while a tab still wants this socket. Full-jitter backoff, so
 *  N clients of one restarted gateway do not redial in lockstep. */
function scheduleRetry(hold: Hold): void {
  if (hold.retry || hold.holders <= 0) {
    return
  }

  const delay = reconnectBackoffDelayMs(hold.attempt)

  hold.attempt += 1
  hold.retry = setTimeout(() => {
    hold.retry = null

    if (hold.holders > 0 && holds.get(hold.connectionId) === hold) {
      hold.opening = dial(hold)
    }
  }, delay)
}

/** Retry now — the error box's button. Cancels the pending rung so the user's
 *  ask is not queued behind a long one. */
export function retryConnectionClient(connectionId: string): void {
  const hold = holds.get(connectionId)

  if (!hold || hold.opening) {
    return
  }

  if (hold.retry) {
    clearTimeout(hold.retry)
    hold.retry = null
  }

  hold.attempt = 0
  hold.opening = dial(hold)
}

/**
 * Catch every session bound to this connection up to its socket.
 *
 * The backend has offered this all along: each session frame is stamped with a
 * per-session monotonic `seq`, `session.events.since` hands back the rest, and
 * `epoch` says which log those numbers belong to. `store/session-replay` holds
 * the decision; this runs it, session by session, and folds what comes back
 * through the ordinary router — the same path a live frame takes, so nothing
 * needs a second reducer.
 *
 * `open_requests` is a SIGNAL, not a frame source (Design v1.3, B4). A snapshot
 * is a JSON-RPC REQUEST (`{id, method, params}`), universal has no server→client
 * request path — its client handles `frame.method === 'event'` and nothing else
 * — and a parked prompt is restored from the RESUME payload. So a non-empty
 * `open_requests` means "this client cannot reconstruct a parked question from
 * the ring", which is the rebind verdict; nothing is synthesised and no
 * unstamped frame can reach the router.
 */
async function catchUp(hold: Hold): Promise<void> {
  const epoch = connectionEpoch(hold.connectionId)

  for (const [key, slice] of Object.entries($sessionKeyStates.get())) {
    if (slice.connectionId !== hold.connectionId || !slice.runtimeSessionId) {
      continue
    }

    const plan = planReplay(key, epoch)

    try {
      if (plan.kind !== 'since') {
        // A different log, or a session this client never stamped a seq for:
        // there is nothing to catch up from incrementally.
        await rebind?.(key, plan.kind)

        continue
      }

      const answer = (await request?.(hold, 'session.events.since', {
        last_seen: plan.seq,
        session_id: slice.runtimeSessionId
      })) as SessionEventsSince | undefined

      const verdict = readEventsSince(key, answer, plan.epoch)

      if (verdict.kind !== 'since') {
        await rebind?.(key, verdict.kind)

        continue
      }

      for (const event of answer?.events ?? []) {
        // Every frame carries the connection that delivered it, and every frame
        // came from the backend's ring — this loop cannot invent one.
        sink?.({ ...(event as GatewayEvent), connectionId: hold.connectionId })
      }

      commitReplayCursor(key, verdict.cursor)
    } catch {
      // A catch-up that cannot run marks the SESSION, not the client (Design
      // v1.3, N1): the socket is live, the next frame arrives as usual, and the
      // other bound sessions still get their turn.
    }
  }
}

/** How a catch-up asks, and how it re-binds a session it cannot catch up
 *  incrementally. Injected, because both answers live in layers that import
 *  this one. */
let request: null | ((hold: Hold, method: string, params: Record<string, unknown>) => Promise<unknown>) = null
let rebind: null | ((sessionKey: string, mode: 'refetch' | 'resume') => Promise<void>)

export function setConnectionClientTransport(next: {
  rebind: (sessionKey: string, mode: 'refetch' | 'resume') => Promise<void>
  request: (scope: { connectionId: string }, method: string, params: Record<string, unknown>) => Promise<unknown>
}): void {
  rebind = next.rebind
  request = (hold, method, params) => next.request({ connectionId: hold.connectionId }, method, params)
}

// A pinned socket went away — its tunnel moved or closed, or something stopped
// it. The tabs on it keep their slices and their runtime ids, which is what
// makes the catch-up possible when it comes back; the ladder starts here.
function watchPinnedCloses(): void {
  setPinnedSecondaryClosedListener((_scopeKey, connectionId) => {
    const hold = holds.get(connectionId)

    if (!hold || hold.holders <= 0) {
      return
    }

    setPhase(connectionId, hold, { attempt: hold.attempt, phase: 'degraded' })
    scheduleRetry(hold)
  })
}

watchPinnedCloses()

/** Live holds on this connection — what makes its client an owning one. */
export function connectionHoldCount(connectionId: string): number {
  return holds.get(connectionId)?.holders ?? 0
}

/** Every connection currently holding an owning client. */
export function ownedConnections(): string[] {
  return [...holds.keys()]
}

export const __testing = {
  reset: (): void => {
    for (const hold of holds.values()) {
      hold.unlisten?.()

      if (hold.retry) {
        clearTimeout(hold.retry)
      }

      unpinSecondary(hold.scopeKey)
    }

    holds.clear()
    $connectionClients.set({})
    // The secondaries' own reset drops every listener, so re-arm ours: it is
    // module wiring, not state.
    watchPinnedCloses()
    sink = null
    rebind = null
    request = null
    forgetStream = null
  }
}
