import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { isKnownRoutePath, routeHead } from '@/app/routes'
import { translateNow } from '@/i18n'
import { type DeepLinkPayload, HERMES_URL_PREFIX, parseHermesDeepLink, resolveDeepLinkAction } from '@/lib/deep-link-routes'
import { normalizeHermesOpenString } from '@/lib/hermes-open-target'

import { notify, notifyError } from './notifications'
import { openAppRoute, ownsPersistedAppState } from './windows'

/**
 * THE deep-link router — one opened `hermes://` URL in, one act out.
 *
 * Rust owns the OS lever and delivers exactly one URL to exactly one window
 * (`src-tauri/src/deep_link.rs`); this file owns what it MEANS. The split is the
 * portability rule: registering a scheme is five different OS mechanisms, while
 * "what does `hermes://plugin/install` do" is one answer on every platform.
 *
 * A deep link is HOSTILE INPUT by definition — any web page can open one — so
 * nothing here performs an action. `mcp/install` and `plugin/install` park a
 * request behind a consent dialog, `blueprint` writes into the composer without
 * submitting, and a navigation resolves only to a route that actually exists.
 *
 * The registry is the extension point (MJXHRM-445's `hermes://bot/<id>`,
 * MJXHRM-447's browser targets): a module registers its kind and side-effect
 * imports itself from `main.tsx`, and nothing in this file changes.
 */

/**
 * The Tauri event Rust delivers on. UNCHANGED from MJXHRM-454, which minted it
 * as a seam with no producer.
 *
 * It is an EVENT name, not a URL, and the two are provably disjoint: an event
 * name is `hermes://<kebab-name>` with no path, a route always has one, and
 * `parseHermesDeepLink` refuses the empty path. `deep-link-routes.test.ts` runs
 * every event name in the tree through the parser to keep it that way.
 */
export const DEEP_LINK_OPEN_EVENT = 'hermes://deep-link-open'

/** A claim on part of the `hermes://` namespace. */
export interface DeepLinkRoute {
  /** URL host. `'*'` matches anything unclaimed. */
  kind: string
  /** Exact path match; omit to claim every path under the kind. */
  name?: string
  /** True = consumed. False lets the next route, then the built-ins, try. */
  handle: (payload: DeepLinkPayload) => boolean
}

const ANY = '*'

const routeKey = (kind: string, name?: string) => `${kind}\u0000${name ?? ANY}`

const routes = new Map<string, DeepLinkRoute>()

/**
 * Claim `(kind, name)`. Returns an IDEMPOTENT unregister that removes only if it
 * is still THIS route — the house shape from `store/agent-read-requests.ts`, so
 * disposing a stale handle after a re-registration cannot unhook the live one.
 *
 * A duplicate claim is REPORTED rather than shadowed: two plugins that both
 * think they own `hermes://foo` is a bug whose only symptom would otherwise be
 * "the link stopped working".
 */
export function registerDeepLinkRoute(route: DeepLinkRoute): () => void {
  const key = routeKey(route.kind, route.name)
  const previous = routes.get(key)

  if (previous) {
    notifyError(
      new Error(`deep-link route ${route.kind}/${route.name ?? ANY} was already claimed`),
      translateNow('deepLink.routeConflict')
    )
  }

  routes.set(key, route)

  return () => {
    if (routes.get(key) === route) {
      routes.delete(key)
    }
  }
}

/** Test seam: drop every registration. */
export function __resetDeepLinkRoutes(): void {
  routes.clear()
}

function claim(payload: DeepLinkPayload): boolean {
  const candidates = [
    routes.get(routeKey(payload.kind, payload.name)),
    routes.get(routeKey(payload.kind)),
    routes.get(routeKey(ANY))
  ]

  for (const route of candidates) {
    if (route?.handle(payload)) {
      return true
    }
  }

  return false
}

/**
 * Navigate to a path a deep link (or a notification activation) produced.
 *
 * THE GUARD desktop does not need. Universal's session route is `/<id>` at the
 * ROOT, so handing an unrecognised path to the router does not 404 — it makes
 * the chat try to hydrate a conversation named after it. So the head must
 * resolve to a real page first, and only then does `openAppRoute` (which knows
 * the Android activity table) take it.
 *
 * Returns whether it navigated.
 */
export function navigateDeepLinkPath(path: string): boolean {
  const resolved = normalizeHermesOpenString(path)

  if (!resolved) {
    notify({ kind: 'error', message: translateNow('deepLink.unsafePath'), title: translateNow('deepLink.title') })

    return false
  }

  if (!isKnownRoutePath(resolved)) {
    notify({
      kind: 'warning',
      message: translateNow('deepLink.unknownPath', routeHead(resolved)),
      title: translateNow('deepLink.title')
    })

    return false
  }

  openAppRoute(resolved)

  return true
}

/**
 * Route ONE opened URL. Returns whether it was consumed.
 *
 * Signature and boolean return are byte-compatible with MJXHRM-454's, which is
 * what let its tests move here and keep their assertions.
 */
export function handleHermesDeepLinkUrl(url: string): boolean {
  const payload = parseHermesDeepLink(url)

  if (!payload) {
    // A foreign scheme cannot reach us and toasting every malformed string is
    // itself a vector, so only a `hermes://` URL we could not read is worth
    // saying anything about — that is also the "you typed an event name" case.
    if (url.trim().startsWith(HERMES_URL_PREFIX)) {
      notify({ kind: 'error', message: translateNow('deepLink.badUrl'), title: translateNow('deepLink.title') })
    }

    return false
  }

  if (claim(payload)) {
    return true
  }

  const action = resolveDeepLinkAction(payload)

  if (action.type === 'navigate') {
    return navigateDeepLinkPath(action.path)
  }

  // Everything else is an action whose OWNER module registers a route for it.
  // Reaching here means that module was never imported (a wiring bug) or the
  // link named a kind nothing claims — either way, say which.
  notify({
    kind: 'warning',
    message:
      action.type === 'ignore' && action.reason === 'unsafe-path'
        ? translateNow('deepLink.unsafePath')
        : translateNow('deepLink.reservedKind', payload.kind),
    title: translateNow('deepLink.title')
  })

  return false
}

let unlisten: null | Promise<UnlistenFn> = null

/**
 * Start listening, then tell Rust we are.
 *
 * ORDER IS THE CONTRACT: subscribe first, invoke second — the same shape as
 * `voice_open` and `ws_open`. `deep_link_ready` DRAINS whatever buffered before
 * this window existed, so an invoke that beat the listener would deliver the
 * cold-start link into nothing.
 *
 * Idempotent, a no-op outside Tauri, and scoped to the window that owns the
 * app's persisted state — a detached tile, a satellite or an Android activity
 * screen must never race the main shell for the same link.
 */
export function startDeepLinkRouter(): void {
  if (unlisten || typeof window === 'undefined' || !ownsPersistedAppState()) {
    return
  }

  unlisten = listen<{ url?: string }>(DEEP_LINK_OPEN_EVENT, event => {
    const url = event.payload?.url

    if (typeof url === 'string') {
      handleHermesDeepLinkUrl(url)
    }
  }).catch(() => () => {})

  void unlisten
    .then(() => invoke<{ delivered: number; dropped: number }>('deep_link_ready'))
    .then(drain => {
      // Rule 9: the cap discarding a link is reported, not swallowed. Logged
      // rather than toasted — the user's intent was the NEWEST link, which did
      // arrive, and a toast about a storm they did not cause is noise.
      if (drain?.dropped) {
        console.warn(`[deep-link] ${drain.dropped} link(s) dropped before the webview was listening`)
      }
    })
    .catch(() => {
      // No Tauri host (a plain-browser dev run) — nothing delivers deep links
      // there, and the listener above is already inert.
    })
}

export function stopDeepLinkRouter(): void {
  void unlisten?.then(off => off())
  unlisten = null
}
