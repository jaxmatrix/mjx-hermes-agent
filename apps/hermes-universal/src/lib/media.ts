import { $connection } from '@/store/connection'

// Lean remote-only media resolver (ported from the remote branch of
// apps/desktop/src/lib/media.ts). Mobile is always a remote gateway client, so
// file/media paths resolve to the gateway's HTTP download endpoint — loadable
// directly by the webview via <img src>. The `&token=` query authenticates in
// token mode; cookie/ticket modes rely on the gateway allowing the download
// (the webview can't share the Rust transport's cookie jar) — FIXME(K4).

export function filePathFromMediaPath(path: string): string {
  if (!path.startsWith('file:')) {
    return path
  }

  try {
    return decodeURIComponent(new URL(path).pathname)
  } catch {
    return path.replace(/^file:\/\//, '')
  }
}

export function mediaExternalUrl(path: string): string {
  if (/^https?:/i.test(path) || /^data:/i.test(path)) {
    return path
  }

  const conn = $connection.get()

  if (conn?.baseUrl) {
    const file = encodeURIComponent(filePathFromMediaPath(path))
    const token = conn.token ? `&token=${encodeURIComponent(conn.token)}` : ''

    return `${conn.baseUrl}/api/files/download?path=${file}${token}`
  }

  return /^file:/i.test(path) ? path : `file://${path}`
}
