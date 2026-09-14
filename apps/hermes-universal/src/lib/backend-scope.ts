/**
 * Composite backend scope keys for the multi-connection registry.
 *
 * VENDORED from `apps/shared/src/backend-scope.ts`, verbatim below the fold —
 * universal declares no `@hermes/shared` dependency and `vite.config.ts` aliases
 * only `@` and `@hermes/plugin-sdk`, so a shared module is copied rather than
 * imported (the precedent headers are `src/gateway/index.ts`,
 * `src/themes/skin-contract.ts`, `src/lib/billing/billing-policy.ts`). Keep the
 * three functions byte-identical to the shared copy: desktop's Electron main and
 * this renderer must derive the SAME key for the same connection.
 *
 * The local/primary connection keeps the BARE profile key: every legacy pool
 * entry, reaper log line, and touch call stays byte-identical for single-source
 * users. Non-local connections get `conn:<id>::<profile>`, which cannot collide
 * with a plain profile name (colons are invalid in profile names).
 *
 * LEAF module: pure, no store imports, no React, no I/O. The one universal
 * addition is `connectionIdOf` + its resolver hook (see below).
 */

import type { Connection } from '@/store/gateway-config'

export const LOCAL_CONNECTION_ID = 'local'

export function backendScopeKey(connectionId: null | string | undefined, profile: null | string | undefined): string {
  const profileKey = String(profile ?? '').trim() || 'default'
  const connection = String(connectionId ?? '').trim()

  if (!connection || connection === LOCAL_CONNECTION_ID) {
    return profileKey
  }

  return `conn:${connection}::${profileKey}`
}

/** Scope a registry route without collapsing its explicit `local` source id.
 *  Null/empty ids still identify the legacy profile-only route. */
export function registryBackendScopeKey(
  connectionId: null | string | undefined,
  profile: null | string | undefined
): string {
  const profileKey = String(profile ?? '').trim() || 'default'
  const connection = String(connectionId ?? '').trim()

  return connection ? `conn:${connection}::${profileKey}` : profileKey
}

/** All pool keys owned by a connection share this prefix (teardown on remove). */
export function backendScopePrefix(connectionId: string): string {
  return `conn:${String(connectionId).trim()}::`
}

// --- universal's half ------------------------------------------------------

/**
 * THE connection identity, for the one connection this app has today.
 *
 * `store/gateway-config.ts#connectionCacheKey` is `mode:profile:identity` — a
 * connection SCOPE, not a bare id, and rule 19 pins its shape across 27 call
 * sites, so it is not re-keyed. This is its identity half with the mode and the
 * profile removed, so `backendScopeKey(connectionIdOf(conn), profile)`
 * reconstructs the pool scope.
 *
 * Never the ssh `baseUrl`: an ssh connection's baseUrl carries a fresh ephemeral
 * port on every re-tunnel, so keying anything durable on it throws the scope
 * away on each reconnect even though the backend is literally the same process
 * (rule 19).
 */
function deriveConnectionId(conn: Connection | null | undefined): string {
  if (!conn) {
    return LOCAL_CONNECTION_ID
  }

  const mode = conn.mode ?? 'remote'

  if (mode === 'local') {
    return LOCAL_CONNECTION_ID
  }

  if (mode === 'ssh') {
    return conn.remoteIdentity || conn.remoteHost || conn.baseUrl
  }

  return conn.baseUrl
}

/**
 * The registry's answer, once there is a registry (MJXHRM-446).
 *
 * A registry mints its connection ids as label slugs, which for connections
 * 2..N is a DIFFERENT string from the derivation above — so once the registry
 * exists it is authoritative and the derivation is only the pre-registry
 * fallback. A hook rather than an import because the registry is a store module
 * and this is a leaf; the house shape is `setSessionTransitionHook` /
 * `setSessionRequestRouter`.
 */
type ConnectionIdResolver = (conn: Connection | null | undefined) => null | string | undefined

let connectionIdResolver: ConnectionIdResolver | null = null

/** Register the registry's resolver. Returns an IDEMPOTENT restore that only
 *  restores if it is still the current resolver. */
export function setConnectionIdResolver(resolver: ConnectionIdResolver): () => void {
  const previous = connectionIdResolver

  connectionIdResolver = resolver

  return () => {
    if (connectionIdResolver === resolver) {
      connectionIdResolver = previous
    }
  }
}

/** The one connection identity: the registry's, or the derivation. */
export function connectionIdOf(conn: Connection | null | undefined): string {
  const resolved = connectionIdResolver?.(conn)

  return (resolved ?? '').trim() || deriveConnectionId(conn)
}
