import { $connection } from '@/store/connection'
import { httpRequest } from '@/transport/http'

// REST helper scoped to the active connection. Mirrors the desktop's
// `window.hermesDesktop.api({ path, method, body })` so ported desktop code can
// call it unchanged — but every call runs through the Rust `http_request`
// command (no webview fetch → no CORS), with the session token attached here.

export interface ApiRequest {
  path: string
  method?: string
  body?: unknown
  timeoutMs?: number
  // Present so the ported desktop REST client (src/hermes.ts) — whose
  // profileScoped() merges a { profile } into every call — compiles unchanged.
  // FIXME(E): mobile is single-profile today, so this is accepted and ignored;
  // thread it into backend selection / a ?profile= query when multi-profile
  // (Track E) lands.
  profile?: string | null
}

export async function api<T = unknown>({ path, method = 'GET', body, timeoutMs }: ApiRequest): Promise<T> {
  const conn = $connection.get()
  if (!conn) throw new Error('Not connected to a Hermes backend')

  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (conn.token) headers['X-Hermes-Session-Token'] = conn.token

  const res = await httpRequest(method, `${conn.baseUrl}${path}`, { headers, body, timeoutMs })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  }
  return (res.body ? JSON.parse(res.body) : undefined) as T
}
