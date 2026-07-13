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
  if (res.status === 401) throw new Error('Invalid username or password')
  if (res.status === 404) throw new Error('This backend has no password login enabled')
  if (res.status === 429) throw new Error('Too many login attempts — try again shortly')
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
  if (!data.ticket) throw new Error('ws-ticket response missing ticket')
  return data.ticket
}
