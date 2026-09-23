/**
 * How universal's own Gateways page searches and describes a source.
 *
 * Desktop's `lib/connection-display` owns ordering and ITS search; these two are
 * universal's, over Rust's row (`ConnectionView`). PURE, and never a secret:
 * `connectionEndpointLabel` renders a host and a user — never a token, a preview
 * or a header value — and drops a URL's userinfo, because this string reaches
 * tooltips and screenshots.
 */

interface SourceRow {
  host?: string
  kind: 'cloud' | 'local' | 'remote' | 'ssh'
  label: string
  port?: number
  remoteProfile?: string
  url?: string
  user?: string
}

/** Accent- and case-insensitive, so "studio" finds "Stüdio". */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/**
 * Matches the label, the transport details (host, user, URL, remote profile) and
 * the kind — the last because "ssh" is what someone types when they are looking
 * for the box they reach that way.
 */
export function connectionSearchMatches(connection: SourceRow, term: string): boolean {
  const needle = fold(term.trim())

  if (!needle) {
    return true
  }

  return [connection.label, connection.kind, connection.url, connection.host, connection.user, connection.remoteProfile]
    .filter((value): value is string => Boolean(value))
    .some(value => fold(value).includes(needle))
}

/**
 * The endpoint, for a row's on-demand detail line. A `local` source has none to
 * show — it is this machine, and its loopback port changes every launch.
 */
export function connectionEndpointLabel(connection: SourceRow): null | string {
  switch (connection.kind) {
    case 'ssh': {
      const host = connection.host ?? ''
      const user = connection.user ? `${connection.user}@` : ''
      const port = connection.port && connection.port !== 22 ? `:${connection.port}` : ''

      return host ? `${user}${host}${port}` : null
    }

    case 'cloud':
    case 'remote':
      try {
        const parsed = new URL(connection.url ?? '')

        return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
      } catch {
        return connection.url ?? null
      }

    default:
      return null
  }
}
