import {
  isHostKeyChangedBootFailure,
  shouldLatchBackendStartFailure,
  shouldLatchHostKeyChangedFailure,
  shouldLatchRemoteReauthFailure
} from '@/lib/backend-start-failure'
import { atom } from '@/store/atom'

/**
 * A source that cannot self-heal, held down until the user acts.
 *
 * P-23: nothing latches today. `store/connection.ts`'s supervisor re-enters
 * `runReconnectLoop` on every `'closed'` and backs off FOREVER, and
 * `rebootstrapSsh` swallows its error and lets the loop keep going — so
 * desktop's 157-failures-over-2.5h bundle against a reinstalled VPS is
 * reproducible here today. A changed host key is terminal by construction
 * (`ssh/known_hosts.rs` calls it "always fatal"): no amount of retrying can
 * succeed until someone verifies the new key.
 *
 * PER CONNECTION, not global. Desktop had one `backendStartFailure` because it
 * had one primary backend; with a registry, one dead source must not stand the
 * supervisor down for the three that are fine.
 *
 * The predicates are `lib/backend-start-failure.ts` — pure, vendored verbatim,
 * and the reason the rule "every remote failure picks exactly one path: retry,
 * reauth latch, or host-key latch" is testable without a socket.
 */

export type LatchReason = 'host-key-changed' | 'local-start-failed' | 'reauth-required'

export interface LatchContext {
  /** True when the failed dial was remote/cloud/ssh rather than a local spawn. */
  attemptedRemote: boolean
  /** True when a credentialed probe got a CONFIRMED 401/403. A transient fault
   *  is not this, and must stay retryable. */
  isReauth?: boolean
  error?: unknown
}

/** connection id → why it is held down. */
export const $latchedConnections = atom<Record<string, LatchReason>>({})

/**
 * Decide, and record. Returns the reason when the failure latched.
 *
 * Exactly one path per failure: a host-key change wins (it is terminal and
 * unmistakable), then a confirmed reauth rejection, then the local-only
 * install-loop break. Anything else is connectivity and stays retryable.
 */
export function latchBackendFailure(connectionId: string, context: LatchContext): LatchReason | null {
  const isHostKeyChanged = isHostKeyChangedBootFailure(context.error)

  const reason: LatchReason | null = shouldLatchHostKeyChangedFailure({
    attemptedRemote: context.attemptedRemote,
    isHostKeyChanged,
    isReauth: context.isReauth === true
  })
    ? 'host-key-changed'
    : shouldLatchRemoteReauthFailure({
          attemptedRemote: context.attemptedRemote,
          isReauth: context.isReauth === true
        })
      ? 'reauth-required'
      : shouldLatchBackendStartFailure({ attemptedRemote: context.attemptedRemote })
        ? 'local-start-failed'
        : null

  if (reason) {
    $latchedConnections.set({ ...$latchedConnections.get(), [connectionId]: reason })
  }

  return reason
}

export function isLatched(connectionId: null | string): LatchReason | null {
  return connectionId ? ($latchedConnections.get()[connectionId] ?? null) : null
}

/**
 * Release one latch.
 *
 * Called by the deliberate user actions the design names: editing the source,
 * trusting the new host key, and an explicit "Try again". Idempotent, so a
 * successful switch can call it unconditionally.
 */
export function releaseLatch(connectionId: string): void {
  const held = $latchedConnections.get()

  if (!(connectionId in held)) {
    return
  }

  const next = { ...held }

  delete next[connectionId]
  $latchedConnections.set(next)
}

export function __resetConnectionLatches(): void {
  $latchedConnections.set({})
}
