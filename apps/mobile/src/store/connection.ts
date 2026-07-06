import { passwordLogin } from '@/lib/auth'
import { loadString, saveString } from '@/lib/persist'
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

const URL_KEY = 'hermes.mobile.url'
const TOKEN_KEY = 'hermes.mobile.token'
const USER_KEY = 'hermes.mobile.username'
// NOTE: plaintext in localStorage, same tradeoff as the token today. Replace with
// Android keystore secure storage before ship (tracked follow-up).
const PASS_KEY = 'hermes.mobile.password'

export const $connection = atom<Connection | null>(null)
export const $connectionPhase = atom<ConnectionPhase>('idle')
export const $connectionError = atom<string | null>(null)
export const $status = atom<StatusInfo | null>(null)

export const lastUrl = (): string => loadString(URL_KEY)
export const lastToken = (): string => loadString(TOKEN_KEY)
export const lastUsername = (): string => loadString(USER_KEY)
export const lastPassword = (): string => loadString(PASS_KEY)

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
    saveString(URL_KEY, input.url.trim())
    saveString(TOKEN_KEY, input.token?.trim() ?? '')
    saveString(USER_KEY, input.username ?? '')
    saveString(PASS_KEY, input.password ?? '')
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
