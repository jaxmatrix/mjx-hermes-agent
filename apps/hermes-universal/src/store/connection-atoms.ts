import { atom } from '@/store/atom'

import type { Connection } from './gateway-config'

/**
 * The live connection's atoms, as a LEAF.
 *
 * They used to live in `store/connection.ts` beside the connect/reconnect
 * machinery, and every reader imported that whole module — including
 * `lib/api.ts`, which needs exactly one atom and nothing else. MJXHRM-446
 * publishes `$connection` from `store/active-connection.ts` inside a `batch()`,
 * which would have closed the loop `connection → active-connection → hermes →
 * api → connection`. Splitting the atoms out breaks it at the leaf instead of
 * threading a registration hook through three modules for one `.set`.
 *
 * `store/connection.ts` re-exports all five, so no existing importer changed.
 * Nothing here imports anything but the store engine — keep it that way.
 */

export type ConnectionPhase = 'idle' | 'probing' | 'connecting' | 'ready' | 'error'

export interface StatusInfo {
  version?: string
  auth_required?: boolean
  auth_providers?: string[]
  /** Which sign-in flows this gateway can run — `"cookie"` always when gated,
   *  `"native_pkce"` only when a provider can broker an RFC 8252 native login
   *  (`hermes_cli/web_server.py`). Absent on gateways older than those routes,
   *  which is the compatibility mechanism: see `lib/native-auth-decisions.ts`.
   *  Rust re-probes this itself before choosing a flow (`oauth.rs`); the field is
   *  declared here so surfaces can say WHICH way the user is signed in. */
  auth_flows?: string[]
  [key: string]: unknown
}

export const $connection = atom<Connection | null>(null)
export const $connectionPhase = atom<ConnectionPhase>('idle')
export const $connectionError = atom<string | null>(null)
export const $status = atom<StatusInfo | null>(null)

/**
 * True once a live connection has been reached in this session (until an explicit
 * disconnect). The root gate reads it so an in-session reconnect (a dropped socket
 * or a settings "Save & reconnect") shows the connecting screen over the mounted
 * shell/Settings instead of bouncing to the full-screen connect picker — the
 * picker is reserved for a genuine first run. Reset by `disconnect()` (deliberate
 * sign-out → back to the picker). Not persisted: a fresh launch starts false and
 * the boot restore (`$restoring`) drives the connecting screen instead.
 */
export const $hasConnected = atom(false)
