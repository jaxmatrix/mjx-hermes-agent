/**
 * PURE address-bar policy for the in-app browser.
 *
 * Ported from the Electron desktop app's normalizer and deliberately NARROWED.
 * Desktop also allowed `blob|chrome|data|devtools|file|ftp|javascript|view-source`
 * on the grounds that "this IS a browser and the person typing already owns the
 * machine". Universal's guest is a webview inside our own process, and Tauri's
 * `is_local_url` turns an app-origin or custom-scheme document into a LOCAL
 * origin that inherits the window's ACL — so that reasoning does not survive
 * the port.
 *
 * Refusing here is a COURTESY. The boundary that matters is the Rust navigation
 * guard (`src-tauri/src/browser/policy.rs`), which refuses the same set
 * independently and also catches redirects, `window.location` and links.
 */

/**
 * `host:port` — the case that makes a naive scheme check wrong. `localhost:5173`
 * and `example.com:8080` both look exactly like `scheme:`, and both are
 * addresses. The digits after the colon are what tell them apart from
 * `mailto:someone` and `javascript:alert(1)`.
 */
const HOST_PORT = /^(\[[0-9a-f:]+\]|[^\s:/?#]+):\d+(?:[/?#]|$)/i

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** A bare loopback host, with or without a port. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i

/**
 * The address a typed string should navigate to, or `null` if it is not one.
 *
 * A bare host gets `http` on loopback and `https` everywhere else: a loopback
 * dev server has no certificate and nothing listening on 443.
 *
 * `hermes://…` deliberately returns `null`. The guest must never navigate
 * there — the bar's caller checks the deep-link table BEFORE calling this and
 * navigates the APP instead, which also removes the footgun of a `hermes://`
 * address reading as an unknown protocol and silently doing nothing.
 */
export function normalizeBrowserAddress(value: string): null | string {
  const address = value.trim()

  if (!address) {
    return null
  }

  // A PATH is not an address. `open_preview` accepts "a web URL, a localhost
  // URL, or a file path" and the gateway passes paths through untouched, so
  // this is the branch that keeps `/repo/src/main.tsx` out of the guest — and
  // `new URL('https:///repo/x')` silently reads `repo` as the HOST, so the
  // parser will not catch it for us.
  if (/^[/~]|^\.{1,2}\/|^[a-z]:[\\/]/i.test(address)) {
    return null
  }

  const bareHost = HOST_PORT.test(address) || !HAS_SCHEME.test(address)

  const candidate = bareHost ? `${LOOPBACK.test(address) ? 'http' : 'https'}://${address}` : address

  try {
    // Parsing is the last gate: `https://` alone, or a string with a space in
    // the host, gets this far and must still be refused.
    const url = new URL(candidate)

    if (url.protocol === 'about:') {
      // `about:blank` is the empty state the pane opens on. Nothing else in
      // the `about:` space is ours to show.
      return url.href.toLowerCase() === 'about:blank' ? 'about:blank' : null
    }

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
