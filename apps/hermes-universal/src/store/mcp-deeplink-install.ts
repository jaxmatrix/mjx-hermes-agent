import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { translateNow } from '@/i18n'
import { MCP_DEEPLINK_ERROR_KEYS, type McpInstallRequest, parseMcpInstallDeepLink } from '@/lib/mcp-deeplink'
import { atom } from '@/store/atom'

import { notify } from './notifications'

/**
 * Pending `hermes://mcp/install` request awaiting the user's explicit
 * confirmation. Set by the deep-link listener, consumed by
 * `McpInstallDeepLinkDialog`; null means no dialog. Nothing is written to
 * config until the user confirms in the dialog.
 */
export const $mcpInstallRequest = atom<McpInstallRequest | null>(null)

/** Validate a deep link's params into a pending install, or toast a rejection. */
export function requestMcpInstallFromDeepLink(params: Record<string, string | undefined>): void {
  const result = parseMcpInstallDeepLink(params)

  if (!result.ok) {
    notify({
      kind: 'error',
      title: translateNow('settings.mcp.deepLinkErrorTitle'),
      message: translateNow(`settings.mcp.${MCP_DEEPLINK_ERROR_KEYS[result.error]}`)
    })

    return
  }

  $mcpInstallRequest.set(result.request)
}

/**
 * The Rust → webview delivery of ONE opened `hermes://` URL.
 *
 * Universal has no OS-level deep-link plumbing yet: `src-tauri` carries no
 * deep-link plugin, `tauri.conf.json` declares no scheme, and the generated
 * AndroidManifest has no BROWSABLE intent-filter (`src-tauri/src/oauth.rs`
 * documents exactly this, which is why gateway OAuth navigates the webview
 * instead of taking a custom-scheme callback). Every other `hermes://…`
 * constant in this app is a Tauri EVENT name, not a URL scheme.
 *
 * So this is the SEAM, and MJXHRM-455 owns the other side of it: register the
 * `hermes` scheme and emit this event with `{ url }` for each opened link —
 * including the URL that COLD-STARTED the process, which has to be buffered
 * until a webview is listening, and including Android's single-webview path,
 * where the launch Activity is reused (`onNewIntent`) rather than a second
 * window being opened, the same constraint the OAuth resume marker works
 * under. Nothing below changes when that lands.
 */
export const DEEP_LINK_OPEN_EVENT = 'hermes://deep-link-open'

/** The one route this app answers today: `hermes://mcp/install?name=…&config=…`. */
const MCP_INSTALL_ROUTE = 'mcp/install'

/**
 * Route one opened `hermes://` URL. Returns true when it was consumed.
 *
 * Hostile input by definition — any web page can open the link — so this only
 * classifies and parks a PENDING request; the dialog requires an explicit
 * confirmation before anything is written.
 */
export function handleHermesDeepLinkUrl(url: string): boolean {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== 'hermes:') {
    return false
  }

  // `hermes://mcp/install?…` is a non-special scheme, so WHATWG parses `mcp`
  // as the host and `/install` as the path. Join them back into the route the
  // vendor wrote, tolerating a trailing slash.
  const route = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '')

  if (route !== MCP_INSTALL_ROUTE) {
    return false
  }

  requestMcpInstallFromDeepLink(Object.fromEntries(parsed.searchParams))

  return true
}

let unlisten: null | Promise<UnlistenFn> = null

/** Listen for opened deep links. Idempotent; a no-op outside Tauri. */
export function startMcpDeepLinkListener(): void {
  if (unlisten || typeof window === 'undefined') {
    return
  }

  unlisten = listen<{ url?: string }>(DEEP_LINK_OPEN_EVENT, event => {
    const url = event.payload?.url

    if (typeof url === 'string') {
      handleHermesDeepLinkUrl(url)
    }
  }).catch(() => () => {})
}

export function stopMcpDeepLinkListener(): void {
  void unlisten?.then(off => off())
  unlisten = null
}
