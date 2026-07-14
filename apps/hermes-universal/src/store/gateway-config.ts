import {
  buildHermesWebSocketUrl,
  type GatewayWsConnection,
  resolveGatewayWsUrl,
} from '@/gateway'
import { mintWsTicket } from '@/lib/auth'

// Reconciled gateway model (D5.a) — the single source of truth for how the app
// reaches a Hermes backend. It unifies two enums that had drifted: this app's
// original `none|token|ticket` (store/connection.ts) and the vendored gateway's
// `oauth|token` (gateway/websocket-url.ts), and adds the desktop-style gateway
// `mode` (local/remote/cloud) that Track E switches between.
//
// Pure + I/O-free except `resolveWsUrl`, whose only effect is the injected
// ws-ticket mint. Everything here is unit-testable against a mocked mint.

/** How the backend is reached. `cloud` is a `remote`-shaped OAuth connection whose
 *  baseUrl was discovered via the portal (see modeIsRemoteLike). */
export type GatewayMode = 'local' | 'remote' | 'cloud'

/** How the WS handshake authenticates.
 *  - `none`   — ungated backend, no auth param.
 *  - `token`  — static `?token=` (loopback / local-spawn).
 *  - `ticket` — gated via password-login; a fresh single-use `?ticket=` per connect.
 *  - `oauth`  — gated via interactive OAuth; also a per-connect `?ticket=`, but a
 *               mint failure means the session expired → re-open sign-in. */
export type AuthMode = 'none' | 'token' | 'ticket' | 'oauth'

export interface Connection {
  baseUrl: string
  authMode: AuthMode
  /** Present only in token mode. */
  token?: string
  /** Gateway mode. Optional for back-compat; treated as `remote` when absent
   *  until Track E makes it explicit at every construction site. */
  mode?: GatewayMode
  /** Multi-profile selector, threaded into the ws-ticket mint. Null/undefined =
   *  the backend's default profile. */
  profile?: null | string
}

/** Cloud reuses the entire remote connect/probe/reconnect path — it differs only
 *  in how `baseUrl` was obtained (portal discovery) and which settings card shows.
 *  Ported from desktop `electron/connection-config.ts` `modeIsRemoteLike`. */
export function modeIsRemoteLike(mode: GatewayMode | undefined): boolean {
  return mode === 'remote' || mode === 'cloud' || mode === undefined
}

export interface StatusLike {
  auth_required?: boolean
  auth_providers?: string[]
}

/** Coarse gated-vs-ungated read of `/api/status`. A gated backend defaults to the
 *  interactive `oauth` path (matching desktop `authModeFromStatus`); the connect
 *  layer downgrades to `ticket` only when the operator supplies password creds for
 *  a password-capable provider. */
export function authModeFromStatus(status: StatusLike): AuthMode {
  return status.auth_required ? 'oauth' : 'none'
}

const WS_PATH = '/api/ws'

/** The mint deps `resolveGatewayWsUrl` needs: a fresh single-use ws-ticket built
 *  from the session cookie the Rust jar holds. Used by both `ticket` and `oauth`. */
export function ticketMintDeps(baseUrl: string): { getGatewayWsUrl: (profile?: null | string) => Promise<string> } {
  const u = new URL(baseUrl)
  return {
    getGatewayWsUrl: async (): Promise<string> => {
      const ticket = await mintWsTicket(baseUrl)
      return buildHermesWebSocketUrl({ protocol: u.protocol, host: u.host, path: WS_PATH, authParam: ['ticket', ticket] })
    },
  }
}

/** Build the WS URL for a connect. `ticket`/`oauth` mint a fresh ticket per connect;
 *  `oauth` routes through the vendored `resolveGatewayWsUrl` so a mint failure raises
 *  `GatewayReauthRequiredError` (→ re-open sign-in) rather than silently degrading. */
export async function resolveWsUrl(conn: Connection): Promise<string> {
  const u = new URL(conn.baseUrl)
  const build = (authParam?: readonly [string, string]): string =>
    buildHermesWebSocketUrl({ protocol: u.protocol, host: u.host, path: WS_PATH, authParam })

  switch (conn.authMode) {
    case 'none':
      return build()
    case 'token':
      return conn.token ? build(['token', conn.token]) : build()
    case 'oauth': {
      const wsConn: GatewayWsConnection = { authMode: 'oauth', profile: conn.profile ?? null, wsUrl: build() }
      return resolveGatewayWsUrl(ticketMintDeps(conn.baseUrl), wsConn)
    }
    case 'ticket':
    default:
      // Mint directly and throw on failure (no ticketless fallback — a gated
      // backend would reject it at the handshake anyway).
      return build(['ticket', await mintWsTicket(conn.baseUrl)])
  }
}
