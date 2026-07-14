import { isGatewayReauthRequired } from '@/gateway'
import { fetchAuthProviders, oauthLogin, oauthLogout, oauthStatus, passwordLogin, portalLogout } from '@/lib/auth'
import { loadString, saveString } from '@/lib/persist'
import { clearSecrets, loadSecrets, saveSecrets, type Secrets } from '@/lib/secure-store'
import { persistSessionCookies } from '@/lib/session-persist'
import { atom } from '@/store/atom'
import { chooseGatedAuth, type Connection } from '@/store/gateway-config'
import { closeGateway, connectGateway } from '@/store/gateway'
import { spawnLocalBackend, stopLocalBackend } from '@/store/local-backend'
import { httpRequest } from '@/transport/http'

// AuthMode / Connection are now defined in store/gateway-config (the reconciled
// model incl. 'oauth' + gateway mode). Re-exported here so existing importers of
// '@/store/connection' keep working.
export type { AuthMode, Connection } from '@/store/gateway-config'

// The RemoteProvider: resolve a LAN/remote Hermes backend URL + auth, then hold
// the live connection descriptor. All chat traffic then runs over the gateway
// (store/gateway.ts). Remote only — no local-spawn mode on mobile.
//
// Two auth shapes:
//   • token / none  — loopback / non-gated backends (auth_required=false):
//                      WS uses ?token= (or nothing).
//   • ticket         — gated backends (auth_required=true): password-login sets a
//                      session cookie (held in Rust), and the WS uses a fresh
//                      single-use ?ticket= minted per connect (store/gateway.ts).

export type ConnectionPhase = 'idle' | 'probing' | 'connecting' | 'ready' | 'error'

export interface StatusInfo {
  version?: string
  auth_required?: boolean
  auth_providers?: string[]
  [key: string]: unknown
}

export interface ConnectInput {
  url: string
  token?: string
  username?: string
  password?: string
}

// Non-secret conveniences live in localStorage for a synchronous prefill; the
// secrets (token/password) live in the OS keyring (see @/lib/secure-store).
const URL_KEY = 'hermes.url'
const USER_KEY = 'hermes.username'

export const $connection = atom<Connection | null>(null)
export const $connectionPhase = atom<ConnectionPhase>('idle')
export const $connectionError = atom<string | null>(null)
export const $status = atom<StatusInfo | null>(null)

export const lastUrl = (): string => loadString(URL_KEY)
export const lastUsername = (): string => loadString(USER_KEY)

/** Read the saved token/password from the keyring (silent; null if none). */
export function loadSavedLogin(): Promise<Secrets | null> {
  return loadSecrets()
}

/** Forget the saved secrets (e.g. a "sign out everywhere" affordance). */
export function forgetSavedLogin(): Promise<void> {
  return clearSecrets()
}

export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim()
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  return value.replace(/\/+$/, '')
}

/** Probe /api/status WITHOUT credentials to learn how the backend authenticates. */
export async function probeStatus(rawUrl: string): Promise<StatusInfo> {
  const base = normalizeBaseUrl(rawUrl)
  const res = await httpRequest('GET', `${base}/api/status`, { timeoutMs: 8000 })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Backend responded HTTP ${res.status}`)
  }
  return JSON.parse(res.body) as StatusInfo
}

export async function connect(input: ConnectInput): Promise<void> {
  const base = normalizeBaseUrl(input.url)
  $connectionError.set(null)
  $connectionPhase.set('probing')

  try {
    const status = await probeStatus(base)
    $status.set(status)

    let conn: Connection
    let oauthProvider: string | undefined
    if (status.auth_required) {
      // Gated: pick the concrete path from the advertised providers. Password
      // login (→ ticket) wins only when the operator supplied credentials AND a
      // provider supports it; otherwise the interactive OAuth path.
      $connectionPhase.set('connecting')
      const providers = await fetchAuthProviders(base)
      const choice = chooseGatedAuth(providers, Boolean(input.username && input.password))

      if (choice.authMode === 'ticket') {
        if (!input.username || !input.password) {
          throw new Error('This backend requires a username and password')
        }
        // password-login sets the session cookie in Rust; the WS authorizes with
        // a per-connect ?ticket= (built in connectGateway).
        await passwordLogin(base, input.username, input.password, choice.provider)
        conn = { baseUrl: base, mode: 'remote', authMode: 'ticket' }
      } else {
        oauthProvider = choice.provider
        // Reuse a still-live session (e.g. a restored cookie jar, R2b) rather than
        // forcing an interactive sign-in; only open the webview when signed out.
        const live = await oauthStatus(base).catch(() => ({ signedIn: false }))
        if (!live.signedIn) {
          await oauthLogin(base, oauthProvider)
        }
        conn = { baseUrl: base, mode: 'remote', authMode: 'oauth' }
      }
    } else if (input.token && input.token.trim()) {
      conn = { baseUrl: base, mode: 'remote', authMode: 'token', token: input.token.trim() }
    } else {
      conn = { baseUrl: base, mode: 'remote', authMode: 'none' }
    }

    $connection.set(conn)
    $connectionPhase.set('connecting')
    try {
      await connectGateway(conn)
    } catch (err) {
      // An OAuth session that expired between the status check and the ws-ticket
      // mint surfaces as GatewayReauthRequiredError — re-run sign-in once.
      if (conn.authMode === 'oauth' && isGatewayReauthRequired(err)) {
        await oauthLogin(base, oauthProvider)
        await connectGateway(conn)
      } else {
        throw err
      }
    }

    $connectionPhase.set('ready')
    // Non-secret prefill in localStorage; secrets in the keyring (best-effort —
    // if the keyring is unavailable, secrets simply aren't persisted).
    saveString(URL_KEY, input.url.trim())
    saveString(USER_KEY, input.username ?? '')
    await saveSecrets({ token: input.token?.trim() || undefined, password: input.password || undefined })
    // Persist the session cookie jar (R2b) so a cookie-backed login (ticket now,
    // oauth/cloud once D6/E land) survives an app restart. No-op in token/none mode.
    await persistSessionCookies()
  } catch (err) {
    $connectionError.set(err instanceof Error ? err.message : String(err))
    $connectionPhase.set('error')
    $connection.set(null)
    throw err
  }
}

/**
 * Local mode (E3.b, desktop-only): spawn a bundled backend and connect to it in
 * token mode. The Rust command resolves only once the backend is HTTP-ready.
 */
export async function connectLocal(profile?: null | string): Promise<void> {
  $connectionError.set(null)
  $connectionPhase.set('connecting')
  try {
    const backend = await spawnLocalBackend(profile)
    const conn: Connection = {
      baseUrl: backend.baseUrl,
      mode: 'local',
      authMode: 'token',
      token: backend.token,
      profile: profile ?? null,
    }
    $connection.set(conn)
    await connectGateway(conn)
    $connectionPhase.set('ready')
  } catch (err) {
    // Tear the child down so a failed connect doesn't leave an orphan process.
    void stopLocalBackend().catch(() => {})
    $connectionError.set(err instanceof Error ? err.message : String(err))
    $connectionPhase.set('error')
    $connection.set(null)
    throw err
  }
}

/**
 * Cloud mode (E5): connect to a portal-discovered agent's gateway. The agent
 * session cookie is already in the shared jar (portal_agent_sign_in ran first),
 * so this is an OAuth-style connect — the WS mints a ticket from that cookie.
 */
export async function connectCloud(baseUrl: string, profile?: null | string): Promise<void> {
  $connectionError.set(null)
  $connectionPhase.set('connecting')
  try {
    const conn: Connection = {
      baseUrl: normalizeBaseUrl(baseUrl),
      mode: 'cloud',
      authMode: 'oauth',
      profile: profile ?? null,
    }
    $connection.set(conn)
    await connectGateway(conn)
    $connectionPhase.set('ready')
    await persistSessionCookies()
  } catch (err) {
    $connectionError.set(err instanceof Error ? err.message : String(err))
    $connectionPhase.set('error')
    $connection.set(null)
    throw err
  }
}

export function disconnect(): void {
  // If we were on a local-spawned backend, stop the child too.
  if ($connection.get()?.mode === 'local') {
    void stopLocalBackend().catch(() => {})
  }
  closeGateway()
  $connection.set(null)
  $connectionPhase.set('idle')
  $connectionError.set(null)
}

/**
 * Sign out: unlike disconnect() (which only drops the socket), this invalidates
 * the session — revokes the gateway OAuth cookie, clears the portal (Privy)
 * session for cloud, forgets stored secrets (incl. the persisted cookie jar),
 * then disconnects.
 */
export async function signOut(): Promise<void> {
  const conn = $connection.get()
  if (conn?.authMode === 'oauth') await oauthLogout(conn.baseUrl).catch(() => {})
  if (conn?.mode === 'cloud') await portalLogout().catch(() => {})
  await forgetSavedLogin().catch(() => {})
  disconnect()
}
