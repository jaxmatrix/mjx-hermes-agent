/**
 * The `hermes://` URL grammar, as a pure classifier.
 *
 * `hermes://<kind>/<name>?<params>` — the HOST is the kind. WHATWG parses a
 * non-special scheme that way, which is what MJXHRM-454's original handler
 * already relied on.
 *
 * PURE (rule 35): no stores, no navigation, no toasts. `store/deep-link.ts`
 * turns an action into an act; this file only says what the URL means, so the
 * grammar can be tested exhaustively without a webview.
 *
 * Ported from `apps/desktop/src/lib/deeplink-routes.ts` — the `repo` resolution
 * order, the `enable`/`force` defaults and `truthyParam` are its semantics
 * verbatim, so a link that works on the desktop app works here.
 */

import { pathFromHermesDeepLink } from './hermes-open-target'

/** Which plugin component a legacy `plugin-agent`/`plugin-desktop` link meant. */
export type PluginInstallLegacyHint = 'agent' | 'desktop' | null

export interface DeepLinkPayload {
  /** URL host — `mcp`, `plugin`, `blueprint`, `open`, or a plugin id. */
  kind: string
  /** Everything after the host, un-percent-decoded per segment by the URL
   *  parser and stripped of the leading and any trailing `/`. */
  name: string
  params: Record<string, string>
  /** The original URL, for a route that wants to re-derive something. */
  url: string
}

export type DeepLinkIgnoreReason = 'bad-url' | 'empty-route' | 'no-route' | 'reserved-kind' | 'unsafe-path'

export type DeepLinkAction =
  | { type: 'composer-blueprint'; name: string; params: Record<string, string> }
  | { type: 'ignore'; reason: DeepLinkIgnoreReason }
  | { type: 'mcp-install'; params: Record<string, string> }
  | { type: 'navigate'; path: string }
  | { enable: boolean; force: boolean; legacyHint: PluginInstallLegacyHint; repo: string; type: 'plugin-install' }

export const HERMES_URL_PREFIX = 'hermes://'

function truthyParam(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined || value === '') {
    return defaultValue
  }

  const normalized = value.trim().toLowerCase()

  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

/**
 * Parse one `hermes://` URL, or null when it is not a route at all.
 *
 * THE DISJOINTNESS INVARIANT. Every app-level Tauri event in this codebase is
 * named `hermes://<kebab-name>` with NO path (rule 23), and every deep-link
 * route has a non-empty one. An empty path therefore returns null here, which is
 * what keeps the two meanings of the `hermes://` prefix from ever being
 * confusable now that the scheme is registered with five operating systems.
 * `deep-link-routes.test.ts` runs every event name in the tree through this
 * function and asserts null.
 */
export function parseHermesDeepLink(url: string): DeepLinkPayload | null {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.protocol !== 'hermes:') {
    return null
  }

  const kind = parsed.hostname

  // A trailing slash is a copy-paste artefact, not a different route.
  const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))

  if (!kind || !name) {
    return null
  }

  return { kind, name, params: Object.fromEntries(parsed.searchParams), url }
}

/**
 * What a payload MEANS. The core kinds get their own action; anything else is a
 * navigation to a plugin-scoped path, refused by the same guard every other
 * untrusted path goes through.
 */
export function resolveDeepLinkAction(payload: DeepLinkPayload): DeepLinkAction {
  const { kind, name, params } = payload

  if (kind === 'mcp' && name === 'install') {
    return { params, type: 'mcp-install' }
  }

  if (kind === 'blueprint') {
    return { name, params, type: 'composer-blueprint' }
  }

  const legacyHint: PluginInstallLegacyHint =
    kind === 'plugin-agent' ? 'agent' : kind === 'plugin-desktop' ? 'desktop' : null

  // `repo` first, then desktop's historical spelling, then — for the LEGACY
  // aliases only — the path itself (`hermes://plugin-agent/owner/repo`).
  //
  // Narrower than desktop on purpose. Desktop falls back to the path for every
  // kind, so its `hermes://plugin/install` with no params resolves a repository
  // literally named `install` and opens the consent dialog for it. Here that is
  // an `ignore` with a reason, which is what a link that named no repository
  // actually means.
  const repo = (params.repo || params.identifier || (legacyHint ? name : '') || '').trim()

  if (repo && (legacyHint || (kind === 'plugin' && name === 'install'))) {
    return {
      enable: truthyParam(params.enable, true),
      force: truthyParam(params.force, false),
      legacyHint,
      repo,
      type: 'plugin-install'
    }
  }

  const path = pathFromHermesDeepLink(kind, name, params)

  if (path) {
    return { path, type: 'navigate' }
  }

  // `pathFromHermesDeepLink` refuses for two different reasons and the user
  // deserves to know which: a core kind nobody handles is a namespace answer, a
  // rejected path is a safety answer.
  return { reason: RESERVED_KINDS_WITHOUT_A_ROUTE.has(kind) ? 'reserved-kind' : 'unsafe-path', type: 'ignore' }
}

/** Core kinds that reach the fallback only when their own route did not fire —
 *  i.e. their handler module was never imported, or the link was malformed. */
const RESERVED_KINDS_WITHOUT_A_ROUTE: ReadonlySet<string> = new Set([
  'blueprint',
  'chat',
  'install',
  'mcp',
  'plugin',
  'plugin-agent',
  'plugin-desktop',
  'settings'
])
