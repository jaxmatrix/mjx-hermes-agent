/**
 * THE path funnel. Every untrusted string that wants to become an in-app route
 * comes through here: an OS deep link, a plugin's notification `activate`
 * target, a context-menu "open in Hermes", a bot room's link.
 *
 * PURE by construction — no store imports, no React, no I/O — so the traversal
 * guard can be unit-tested without a webview and, more importantly, so there is
 * exactly ONE of it. A guard duplicated at each call site is a guard that is
 * eventually missing at one of them.
 *
 * Ported from `apps/desktop/src/lib/hermes-open-target.ts` and kept
 * source-compatible with it: a plugin whose deep link works on the desktop app
 * must resolve to the same path here.
 *
 * Supported shapes:
 *  - `hermes://index-network/intent/1` → `/index-network/intent/1` (plugin-scoped)
 *  - `hermes://open/my-page?item=x`    → `/my-page?item=x` (generic open)
 *  - `/my-page?item=x` / `#/my-page?item=x` (hash-router paths)
 *
 * Note what this module does NOT decide: whether the resolved path actually
 * leads anywhere. `store/deep-link.ts#navigateDeepLinkPath` owns that, because
 * universal's session route is `/<id>` at the ROOT — so an unrecognised path is
 * not a harmless 404 here the way it is on desktop, it is a hydrate attempt for
 * a session that does not exist.
 */

export type HermesOpenTarget = string | { href: string } | { path: string; params?: Record<string, string> }

const HERMES_PROTOCOL = 'hermes:'

/**
 * Deep-link hosts owned by core handlers, and therefore never read as a plugin
 * id.
 *
 * Desktop's list, plus any kind universal claims. Adding one takes a name away
 * from every plugin that could have used it as an id, so it must read as a
 * decision in a diff rather than as a passing edit — see
 * `store/deep-link.ts#registerDeepLinkRoute`, whose worked example is exactly
 * this pair of steps.
 */
export const RESERVED_DEEP_LINK_KINDS: ReadonlySet<string> = new Set([
  'blueprint',
  // MJXHRM-445: `hermes://bot/<name>` and `hermes://bot/<name>/room/<roomId>`,
  // registered by the in-tree Bot Mode plugin. In-tree, but the kind is a CORE
  // reservation — an installed agent package named `bot` must not be able to
  // claim the notification links Bot Mode's own rooms hand out.
  'bot',
  'chat',
  'install',
  'mcp',
  'open',
  'plugin',
  'plugin-agent',
  'plugin-desktop',
  'settings'
])

function appendSearch(path: string, params: Record<string, string> | undefined | URLSearchParams): string {
  if (!params) {
    return path
  }

  const search =
    params instanceof URLSearchParams
      ? params
      : new URLSearchParams(Object.entries(params).filter(([, value]) => value != null && value !== ''))

  const qs = search.toString()

  if (!qs) {
    return path
  }

  return path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`
}

/** An absolute in-app path with no traversal and no scheme smuggling. */
export function isSafeAppPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false
  }

  // `..` is traversal; `\` is a Windows separator a path resolver may fold; `:`
  // is how a scheme (`javascript:`) hides inside something that looks relative.
  return !path.includes('..') && !path.includes('\\') && !path.includes(':')
}

/** A URL host that may be read as a plugin id rather than a core kind. */
export function isPluginDeepLinkHost(host: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(host) && !RESERVED_DEEP_LINK_KINDS.has(host)
}

/** Normalize a string target to a hash-router path, or null. */
export function normalizeHermesOpenString(raw: string): null | string {
  const trimmed = raw.trim()

  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith(`${HERMES_PROTOCOL}//`)) {
    try {
      const url = new URL(trimmed)
      const host = url.hostname || ''
      const rest = decodeURIComponent((url.pathname || '').replace(/^\//, ''))

      if (!rest) {
        return null
      }

      // `hermes://open/<path>?…` → `/<path>?…`; anything else is plugin-scoped,
      // so the host becomes the first path segment.
      if (host !== 'open' && !isPluginDeepLinkHost(host)) {
        return null
      }

      const path = host === 'open' ? `/${rest}` : `/${host}/${rest}`

      if (!isSafeAppPath(path.split('?')[0] ?? path)) {
        return null
      }

      return appendSearch(path, url.searchParams)
    } catch {
      return null
    }
  }

  const path = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed

  return isSafeAppPath(path.split('?')[0] ?? path) ? path : null
}

/** Resolve any supported activate/open target to a hash-router path, or null. */
export function resolveHermesOpenPath(target: HermesOpenTarget | null | undefined): null | string {
  if (target == null) {
    return null
  }

  if (typeof target === 'string') {
    return normalizeHermesOpenString(target)
  }

  if (typeof target !== 'object') {
    return null
  }

  if ('href' in target && typeof target.href === 'string') {
    return normalizeHermesOpenString(target.href)
  }

  if ('path' in target && typeof target.path === 'string') {
    const base = normalizeHermesOpenString(target.path)

    return base ? appendSearch(base, target.params) : null
  }

  return null
}

/** Build a navigate path from a parsed deep-link payload's parts. */
export function pathFromHermesDeepLink(
  kind: string,
  name: string,
  params: Record<string, string> = {}
): null | string {
  if (!kind || !name) {
    return null
  }

  if (kind === 'open') {
    return resolveHermesOpenPath({ params, path: `/${name.replace(/^\//, '')}` })
  }

  if (!isPluginDeepLinkHost(kind)) {
    return null
  }

  return resolveHermesOpenPath({ params, path: `/${kind}/${name.replace(/^\//, '')}` })
}
