import { passwordLogin } from '@/lib/auth'
import { loadString, saveString } from '@/lib/persist'
import { clearSecrets, loadSecrets, saveSecrets, type Secrets } from '@/lib/secure-store'
import { persistSessionCookies } from '@/lib/session-persist'
import { atom } from '@/store/atom'
import { closeGateway, connectGateway } from '@/store/gateway'
import { httpRequest } from '@/transport/http'

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

export type AuthMode = 'none' | 'token' | 'ticket'
export type ConnectionPhase = 'idle' | 'probing' | 'connecting' | 'ready' | 'error'

export interface Connection {
  baseUrl: string
  authMode: AuthMode
  /** Present only in token mode. */
  token?: string
}

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
    if (status.auth_required) {
      // Gated: password-login first (sets the session cookie in Rust), then the
      // WS authorizes with a per-connect ?ticket= (built in connectGateway).
      if (!input.username || !input.password) {
        throw new Error('This backend requires a username and password')
      }
      $connectionPhase.set('connecting')
      await passwordLogin(base, input.username, input.password)
      conn = { baseUrl: base, authMode: 'ticket' }
    } else if (input.token && input.token.trim()) {
      conn = { baseUrl: base, authMode: 'token', token: input.token.trim() }
    } else {
      conn = { baseUrl: base, authMode: 'none' }
    }

    $connection.set(conn)
    $connectionPhase.set('connecting')
    await connectGateway(conn)

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

export function disconnect(): void {
  closeGateway()
  $connection.set(null)
  $connectionPhase.set('idle')
  $connectionError.set(null)
}
