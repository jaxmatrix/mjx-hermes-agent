import type { ConnectionView } from '@/store/connections'

/**
 * How a list of sources is ordered, searched and described.
 *
 * PURE, and never exposes a secret: `connectionEndpointLabel` renders a host and
 * a user, never a token, never a preview, never a header value. Desktop states
 * the same rule as a test name — *"keeps technical endpoints available on demand
 * without exposing secrets"* — and it is the reason the Gateways page shows an
 * endpoint on demand rather than always: a screen-share should not publish a
 * Tailscale topology.
 */

/** Below this many sources the list is short enough to read; a search box would
 *  be chrome with nothing to do. */
export const CONNECTION_SEARCH_THRESHOLD = 8

/**
 * Local first (it is this device), then labels case-insensitively with numeric
 * order so "box 2" sorts before "box 10".
 *
 * Returns a NEW array: the registry's own order is the durable `order` field and
 * must not be disturbed by a display concern.
 */
export function sortConnectionsForDisplay(connections: ConnectionView[]): ConnectionView[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

  return [...connections].sort((a, b) => {
    if (a.kind !== b.kind && (a.kind === 'local' || b.kind === 'local')) {
      return a.kind === 'local' ? -1 : 1
    }

    return collator.compare(a.label, b.label) || a.order - b.order
  })
}

/** Accent- and case-insensitive, so "studio" finds "Stüdio". */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/**
 * Does this source match a search term?
 *
 * Matches the label, the transport details (host, user, URL, remote profile) and
 * the kind — the last because "ssh" is what someone types when they are looking
 * for the box they reach that way.
 */
export function connectionSearchMatches(connection: ConnectionView, term: string): boolean {
  const needle = fold(term.trim())

  if (!needle) {
    return true
  }

  return [connection.label, connection.kind, connection.url, connection.host, connection.user, connection.remoteProfile]
    .filter((value): value is string => Boolean(value))
    .some(value => fold(value).includes(needle))
}

/**
 * The endpoint, for the row's on-demand detail line.
 *
 * A `local` source has no address to show — it is this machine — and saying
 * "127.0.0.1:<ephemeral port>" would be a number that changes every launch.
 */
export function connectionEndpointLabel(connection: ConnectionView): null | string {
  switch (connection.kind) {
    case 'ssh': {
      const host = connection.host ?? ''
      const user = connection.user ? `${connection.user}@` : ''
      const port = connection.port && connection.port !== 22 ? `:${connection.port}` : ''

      return host ? `${user}${host}${port}` : null
    }

    case 'cloud':
    case 'remote':
      // Host and path only: the URL's userinfo half can carry a password
      // (`normalizeBaseUrl` keeps whatever was typed), and this string reaches
      // tooltips and screenshots.
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

/** Which sources address the SAME backend, by install id. Only the rows AFTER
 *  the first are hinted, so the hint reads as information rather than an
 *  accusation against the one the user set up first. */
export function sameBackendHints(installIds: Record<string, string | undefined>): Record<string, string> {
  const firstByInstall = new Map<string, string>()
  const hints: Record<string, string> = {}

  for (const [connectionId, installId] of Object.entries(installIds)) {
    if (!installId) {
      continue
    }

    const first = firstByInstall.get(installId)

    if (first) {
      hints[connectionId] = first
    } else {
      firstByInstall.set(installId, connectionId)
    }
  }

  return hints
}
