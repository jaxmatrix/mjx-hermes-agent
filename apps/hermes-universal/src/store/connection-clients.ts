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
 *  * ONE socket per connection (invariant 32). `clientFor` answers `ambient` for
 *    the active connection, so a tab there opens nothing — the app already holds
 *    that socket, and a second one would double every frame.
 *  * PINNED means never evicted and never reaped (invariant 33). Evicting the
 *    socket a visible tab streams on is the failure `gateway-secondaries`'
 *    header warns about, one rung worse; the cap goes on governing request-only
 *    sockets, and owning clients are bounded by "connections with an open tab".
 *  * The LAST tab closing DEMOTES, it does not kill (invariant 34). The socket
 *    becomes request-only and leaves on the existing 60 s idle reap, so
 *    reopening a tab inside that window is warm. An immediate close is only for
 *    a connection that was removed or edited, and for quit.
 *
 * Refcounted by TAB, not by request: `hold`/`release` are the two verbs, and a
 * connection with one tab open holds one socket however many requests ride it.
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
import { normalizeProfileKey } from '@/store/profile'
import { connectionEpoch, planReplay, readEventsSince, type SessionEventsSince } from '@/store/session-replay'
import { $sessionStates } from '@/store/session-state-types'

/** What a tab's work goes through. */
export type ConnectionClient =
  /** The app's own socket: the tab is on the active connection. */
  | { kind: 'ambient' }
  /** This connection's own socket, held for as long as a tab needs it. */
  | { kind: 'owning'; connectionId: string; scopeKey: string }

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
  phase: ConnectionClientPhase
  /** Which rung of the backoff ladder we are on; 0 while live. */
  attempt: number
  /** Why it is lost, for the error box. */
  error?: string
  /** A terminal failure: retrying cannot fix it, the user must act. */
  terminal?: boolean
}

/** Per connection, for the tabs bound to it. The UI reads this; nothing else
 *  in the store layer branches on it. */
export const $connectionClients = atom<Record<string, ConnectionClientState>>({})

function setPhase(connectionId: string, state: ConnectionClientState): void {
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

interface Hold {
  connectionId: string
  scopeKey: string
  profile: null | string
  /** The backoff timer, while the ladder is climbing. */
  retry: null | ReturnType<typeof setTimeout>
  attempt: number
  /** Open tabs bound to this connection. The socket lives while it is > 0. */
  tabs: number
  /** Undoes the event listener, so a demoted client stops routing frames. */
  unlisten: null | (() => void)
  /** The open in flight, if any — so two tabs binding at once share it. */
  opening: null | Promise<void>
}

const holds = new Map<string, Hold>()

/** How a frame from a connection's own socket reaches the app. Registered by the
 *  owning client alone: `deliver()` drops anything nobody claims (rule 7). */
let sink: ((event: GatewayEvent) => void) | null = null

export function setConnectionEventSink(next: (event: GatewayEvent) => void): void {
  sink = next
}

const scopeOf = (connectionId: string, profile: null | string | undefined): string =>
  backendScopeKey(connectionId, normalizeProfileKey(profile ?? 'default'))

/** Whether `connectionId` is the one the app itself is pointed at. */
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
export function clientFor(connectionId: string, profile?: null | string): ConnectionClient {
  if (isAmbientConnection(connectionId)) {
    return { kind: 'ambient' }
  }

  return { connectionId, kind: 'owning', scopeKey: scopeOf(connectionId, profile) }
}

/**
 * A tab bound to `connectionId` opened.
 *
 * Idempotent per tab: the caller holds once and releases once. The first hold on
 * a non-ambient connection pins the scope and opens its socket; later holds
 * share it, including one taken while the first is still opening (a cold SSH
 * dial is 45–90 s, and two tabs restored together must not start two dials).
 */
export async function holdConnectionClient(connectionId: string, profile?: null | string): Promise<void> {
  const client = clientFor(connectionId, profile)

  if (client.kind === 'ambient') {
    return
  }

  const { scopeKey } = client
  const existing = holds.get(scopeKey)

  if (existing) {
    existing.tabs += 1

    return existing.opening ?? undefined
  }

  const hold: Hold = {
    attempt: 0,
    connectionId,
    opening: null,
    profile: profile ?? null,
    retry: null,
    scopeKey,
    tabs: 1,
    unlisten: null
  }

  holds.set(scopeKey, hold)
  // BEFORE the open: a pin taken while the socket is still opening survives it,
  // so a slow dial cannot be evicted by an unrelated request-only lease landing
  // in the meantime.
  pinSecondary(scopeKey)

  hold.unlisten = addConnectionEventListener(connectionId, event => sink?.(event))
  hold.opening = dial(hold)

  return hold.opening
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
  setPhase(hold.connectionId, { attempt: hold.attempt, phase: 'opening' })

  const open = leaseSecondary(hold.scopeKey, hold.connectionId)
    .then(async () => {
      hold.attempt = 0
      setPhase(hold.connectionId, { attempt: 0, phase: 'live' })
      await catchUp(hold)
    })
    .catch((error: unknown) => {
      // A tunnel that needs a credential or a prompt will not come back by
      // being retried: stop the ladder and let the surface offer Connect.
      const terminal = isTunnelSignInError(error) || needsInteraction((error as { status?: never })?.status)

      setPhase(hold.connectionId, {
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
  if (hold.retry || hold.tabs <= 0) {
    return
  }

  const delay = reconnectBackoffDelayMs(hold.attempt)

  hold.attempt += 1
  hold.retry = setTimeout(() => {
    hold.retry = null

    if (hold.tabs > 0 && holds.get(hold.scopeKey) === hold) {
      hold.opening = dial(hold)
    }
  }, delay)
}

/** Retry now — the error box's button. Cancels the pending rung so the user's
 *  ask is not queued behind a long one. */
export function retryConnectionClient(connectionId: string, profile?: null | string): void {
  const hold = holds.get(scopeOf(connectionId, profile))

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
 * `open_requests` FIRST: the ring cannot carry "a question still waiting", so a
 * clarify or an approval parked in `_block` is re-delivered before the frames
 * that follow it, exactly as the shared channel's contract promises.
 */
async function catchUp(hold: Hold): Promise<void> {
  const epoch = connectionEpoch(hold.connectionId)

  for (const [key, slice] of Object.entries($sessionStates.get())) {
    if (slice.connectionId !== hold.connectionId || !slice.runtimeSessionId) {
      continue
    }

    const plan = planReplay(key, epoch)

    if (plan.kind !== 'since') {
      // A different log, or a session this client never stamped a seq for:
      // there is nothing to resume from incrementally.
      await rebind?.(key, plan.kind)

      continue
    }

    try {
      const answer = await request?.(hold, 'session.events.since', {
        last_seen: plan.seq,
        session_id: slice.runtimeSessionId
      })

      for (const open of (answer as SessionEventsSince | undefined)?.open_requests ?? []) {
        sink?.(open as GatewayEvent)
      }

      const verdict = readEventsSince(key, answer as SessionEventsSince | undefined)

      if (verdict?.kind === 'refetch') {
        await rebind?.(key, 'refetch')

        continue
      }

      for (const event of (answer as SessionEventsSince | undefined)?.events ?? []) {
        sink?.({ ...(event as GatewayEvent), connectionId: hold.connectionId })
      }
    } catch {
      // A catch-up that cannot run is not a reason to tear anything down: the
      // socket is live, and the next frame arrives as usual.
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
  request: (
    scope: { connectionId: string; profile: null | string },
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>
}): void {
  rebind = next.rebind
  request = (hold, method, params) =>
    next.request({ connectionId: hold.connectionId, profile: hold.profile }, method, params)
}

/**
 * A tab bound to `connectionId` closed.
 *
 * The last one DEMOTES the socket to request-only: it stops routing frames (no
 * tab is listening) and joins the ordinary idle reap, so a reopen inside the
 * minute finds it warm. It is not closed here — that is a connection being
 * removed or edited, or quit.
 */
export function releaseConnectionClient(connectionId: string, profile?: null | string): void {
  const scopeKey = scopeOf(connectionId, profile)
  const hold = holds.get(scopeKey)

  if (!hold) {
    return
  }

  hold.tabs -= 1

  if (hold.tabs > 0) {
    return
  }

  holds.delete(scopeKey)
  hold.unlisten?.()
  hold.unlisten = null

  if (hold.retry) {
    clearTimeout(hold.retry)
    hold.retry = null
  }

  clearPhase(connectionId)
  unpinSecondary(scopeKey)
}

// A pinned socket went away — its tunnel moved or closed, or something stopped
// it. The tabs on it keep their slices and their runtime ids, which is what
// makes the catch-up possible when it comes back; the ladder starts here.
function watchPinnedCloses(): void {
  setPinnedSecondaryClosedListener(scopeKey => {
    const hold = holds.get(scopeKey)

    if (!hold || hold.tabs <= 0) {
      return
    }

    setPhase(hold.connectionId, { attempt: hold.attempt, phase: 'degraded' })
    scheduleRetry(hold)
  })
}

watchPinnedCloses()

/** Open tabs on this connection — what makes its client an owning one. */
export function connectionTabCount(connectionId: string, profile?: null | string): number {
  return holds.get(scopeOf(connectionId, profile))?.tabs ?? 0
}

/** Every connection currently holding an owning client. */
export function ownedConnections(): string[] {
  return [...holds.values()].map(hold => hold.connectionId)
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
  }
}
