import { invoke } from '@tauri-apps/api/core'

import { httpRequest } from '@/transport/http'

// Gated-mode auth (auth_required=true). All requests run through the Rust
// transport, whose reqwest client has a cookie jar — so the session cookie set
// by password-login is automatically carried into the ws-ticket POST. We set an
// explicit Origin (a native client has none by default) so the gated middleware
// accepts the state-changing POSTs.

/** POST /auth/password-login → session cookie (held in the Rust cookie jar). */
export async function passwordLogin(
  base: string,
  username: string,
  password: string,
  provider = 'basic'
): Promise<void> {
  const res = await httpRequest('POST', `${base}/auth/password-login`, {
    headers: { Origin: base },
    body: { provider, username, password, next: '' },
    timeoutMs: 10_000
  })

  if (res.status === 401) {
    throw new Error('Invalid username or password')
  }

  if (res.status === 404) {
    throw new Error('This backend has no password login enabled')
  }

  if (res.status === 429) {
    throw new Error('Too many login attempts — try again shortly')
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Login failed (HTTP ${res.status})`)
  }
}

/** POST /api/auth/ws-ticket → single-use 30s ticket for the WS upgrade. */
export async function mintWsTicket(base: string): Promise<string> {
  const res = await httpRequest('POST', `${base}/api/auth/ws-ticket`, {
    headers: { Origin: base },
    timeoutMs: 10_000
  })

  if (res.status === 401) {
    throw new Error('Session expired — sign in again')
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Could not obtain a WebSocket ticket (HTTP ${res.status})`)
  }

  const data = JSON.parse(res.body) as { ticket?: string }

  if (!data.ticket) {
    throw new Error('ws-ticket response missing ticket')
  }

  return data.ticket
}

// ---------------------------------------------------------------------------
// Connection-level OAuth (Track D). The interactive flow + cookie capture live
// in Rust (src-tauri/src/oauth.rs); these are the typed JS bindings.
// ---------------------------------------------------------------------------

export interface AuthProvider {
  name: string
  display_name: string
  supports_password: boolean
}

/** GET /api/auth/providers → the interactive sign-in options a gated backend
 *  advertises. Returns [] when none are registered (503) so callers can fall
 *  back to the default provider. */
export async function fetchAuthProviders(base: string): Promise<AuthProvider[]> {
  const res = await httpRequest('GET', `${base}/api/auth/providers`, { timeoutMs: 8_000 })

  if (res.status === 503) {
    return []
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Could not load auth providers (HTTP ${res.status})`)
  }

  const data = JSON.parse(res.body) as { providers?: AuthProvider[] }

  return data.providers ?? []
}

/** Run the interactive gateway OAuth flow (opens the sign-in webview in Rust).
 *  On success the session cookie lives in the shared jar; connect normally after. */
export async function oauthLogin(base: string, provider?: string): Promise<void> {
  await invoke('oauth_login', { base, provider: provider ?? null })
}

export interface OauthStatus {
  signedIn: boolean
  email?: string | null
  displayName?: string | null
}

/** Whether the shared jar currently holds a live gateway session (GET /api/auth/me). */
export async function oauthStatus(base: string): Promise<OauthStatus> {
  return invoke<OauthStatus>('oauth_status', { base })
}

/** Sign out (POST /auth/logout); clears the session cookie from the shared jar. */
export async function oauthLogout(base: string): Promise<void> {
  await invoke('oauth_logout', { base })
}

/** Clear the Nous portal (Privy) session held in the portal webview. Best-effort. */
export async function portalLogout(): Promise<void> {
  await invoke('portal_logout')
}

/** Silent SSO into a cloud agent's gateway using the live portal session. */
export async function portalAgentSignIn(dashboardUrl: string): Promise<{ connected: boolean; baseUrl: string }> {
  return invoke<{ connected: boolean; baseUrl: string }>('portal_agent_sign_in', { dashboardUrl })
}
