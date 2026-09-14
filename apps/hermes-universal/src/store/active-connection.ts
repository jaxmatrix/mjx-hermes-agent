import { setApiRequestProfile } from '@/hermes'
import { backendScopeKey, connectionIdOf } from '@/lib/backend-scope'
import { atom, batch, computed } from '@/store/atom'
import { $connection } from '@/store/connection-atoms'
import type { Connection, GatewayMode } from '@/store/gateway-config'
import { $gatewayMode } from '@/store/gateway-switch'

/**
 * WHICH SOURCE THE APP IS ON — published as ONE value, in ONE notification.
 *
 * The bug this closes is a torn read, not a missing feature. Today
 * `store/connection.ts` sets `$connection`, then awaits `connectGateway`, then
 * sets the phase to `ready`; in that window `api()` fires REST at the NEW base
 * while the UI still says "connecting" and `_apiProfile` may still describe the
 * OLD source. Four independent writes with awaits between them is a state
 * machine nobody can reason about, and with more than one connection it stops
 * being cosmetic: a call lands on a backend that never heard of the session.
 *
 * So the IDENTITY half — which connection, which profile, which base URL — is
 * published together inside `batch()`. Everything else DERIVES.
 *
 * NOT in the batch, deliberately: `$connectionPhase`, `$gatewayState`,
 * `$hasConnected`, `$gatewaySwitching` and `$restoring`. Those are TRANSITIONS,
 * not identity. Folding them in would rewrite the descriptor on every socket
 * heartbeat and force every consumer of `$activeConnection` to re-render for a
 * state it does not read. Rule 12 forbids a seventh FLAG; this is not one —
 * nothing here is a flag, and `$connectionReady` (store/connection-ready.ts)
 * stays the one derived answer over the six that exist.
 */

export interface ActiveConnection {
  /** Registry id. `LOCAL_CONNECTION_ID` for a single-source install. */
  connectionId: string
  /** `backendScopeKey(dialConnectionId, profile)` — MJXHRM-480's key. BARE for
   *  the connection that inherited the pre-registry world. */
  scopeKey: string
  /** The dialable descriptor. `token` is absent for a registered connection —
   *  Rust attaches it (MJXHRM-413). */
  connection: Connection
  /** Normalized profile key (`'default'` when unset). */
  profile: string
  /** Display label, so no surface has to join against the registry to paint a
   *  chip. */
  label: string
  kind: GatewayMode
  /**
   * The id a DIAL carries — `null` for the legacy owner.
   *
   * Not the same thing as `connectionId`, and the difference is the whole
   * upgrade story: passing `null` is what collapses `ssh_ownership_id` back to
   * the bare profile so a running remote backend is reattached rather than
   * orphaned. Rust decides which one this is (`registry::dial_connection_id`);
   * the webview only carries the answer.
   */
  dialConnectionId: null | string
}

export const $activeConnection = atom<ActiveConnection | null>(null)

/**
 * The active connection's id, or null.
 *
 * Deliberately does NOT fall back to the registry's `primary`: `primary` is the
 * default for the next launch, not a claim about what THIS WebView is on. A
 * satellite window that has not finished restoring would otherwise answer with a
 * connection it is not talking to, and every seam keyed on the id — the session
 * router, the forward lease, the merged rows' tag — would key on the wrong one.
 */
export const $activeConnectionId = computed($activeConnection, active => active?.connectionId ?? null)

/** The scope key of the live source, for the pool / lease / router seams. */
export const $activeScopeKey = computed($activeConnection, active => active?.scopeKey ?? null)

/** True once more than nothing is known — used only to gate optional chrome. */
export const $activeConnectionLabel = computed($activeConnection, active => active?.label ?? null)

/** The registry facts a dial carries, when it came from the registry. */
export interface ConnectionDescriptorHint {
  connectionId: string
  label: string
  /** `null` for the legacy owner — see `ActiveConnection.dialConnectionId`. */
  dialConnectionId: null | string
}

/**
 * What `selectConnection` learned from `connections_resolve`, parked for the
 * connect helper that is about to publish.
 *
 * A hint rather than a parameter because the four connect* helpers are called
 * from eleven places (boot restore, rollback, the configurator, the peer
 * re-home, the mobile OAuth resume) and only one of them has a registry row —
 * widening all four signatures would make ten call sites carry `undefined`.
 * One-shot: taken by the first publish, so a later ambient reconnect cannot
 * inherit a stale identity.
 */
let pendingHint: ConnectionDescriptorHint | null = null

export function setPendingConnectionHint(hint: ConnectionDescriptorHint | null): void {
  pendingHint = hint
}

export function takePendingConnectionHint(): ConnectionDescriptorHint | null {
  const held = pendingHint

  pendingHint = null

  return held
}

function normalizeProfile(profile: null | string | undefined): string {
  return (profile ?? '').trim() || 'default'
}

/**
 * Turn a dialable descriptor into the published identity.
 *
 * With no hint this is exactly the pre-registry world: `connectionIdOf` answers
 * (the registry's resolver first, its own derivation otherwise) and the dial id
 * is null, so the scope key is the bare profile and nothing about a
 * single-source install moves.
 */
export function describeConnection(
  connection: Connection,
  hint: ConnectionDescriptorHint | null = null
): ActiveConnection {
  const profile = normalizeProfile(connection.profile)

  return {
    connection,
    connectionId: hint?.connectionId ?? connectionIdOf(connection),
    dialConnectionId: hint?.dialConnectionId ?? null,
    kind: connection.mode ?? 'remote',
    label: hint?.label ?? connection.remoteHost ?? connection.baseUrl,
    profile,
    scopeKey: backendScopeKey(hint?.dialConnectionId ?? null, profile)
  }
}

/**
 * THE publication. The only writer of the identity half.
 *
 * `batch()` is nanostores 1.4.2's (pinned since Step 0 — 1.4.0/1.4.1 erased it
 * under Rollup), re-exported through `@/store/atom` like every other store
 * primitive.
 */
export function publishActiveConnection(next: ActiveConnection | null): void {
  batch(() => {
    $activeConnection.set(next)
    // The descriptor `api()` reads at call time (rule 13).
    $connection.set(next?.connection ?? null)

    if (next) {
      $gatewayMode.set(next.connection.mode ?? next.kind)
      // The REST scope moves WITH the identity, so no call can be made against
      // the new base under the old source's profile.
      //
      // Only on a non-null publish, which is a deliberate narrowing of the
      // design: a disconnect is not a profile change, and resetting the scope
      // there would silently diverge from the persisted `$activeProfile` that
      // `store/profiles.ts` owns and re-applies at module load.
      setApiRequestProfile(next.profile === 'default' ? null : next.profile)
    }
  })
}

/**
 * FAIL OPEN — and this is not negotiable.
 *
 * When the descriptor lookup for a switch target fails (the source was edited or
 * removed mid-dial, the registry read errored, the keyring lease expired), keep
 * every atom on the previous connection and let the switch complete against what
 * we already had.
 *
 * Desktop shipped the opposite. Its fail-closed atomic publish (#89483) turned
 * routine registry churn into dead profile clicks (#89622) and was reverted in
 * #89785. Universal inherits the conclusion, not the attempt. What it does NOT
 * inherit is the silence: the caller warns, because a switch that quietly did
 * nothing is the half of #89622 that made it hard to diagnose.
 */
export async function withFailOpenDescriptor<T>(
  lookup: Promise<ActiveConnection | null>,
  activate: Promise<T>
): Promise<{ descriptor: ActiveConnection | null; activated: T }> {
  // Resolved CONCURRENTLY so nothing awaits between activation and publication
  // — desktop's `profile.ts:425-428`. A sequential pair reopens the very window
  // the batch exists to close.
  const [descriptor, activated] = await Promise.all([lookup.catch(() => null), activate])

  return { activated, descriptor }
}
