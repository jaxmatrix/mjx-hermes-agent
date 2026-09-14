// Pure DOM classification for the app-wide context menu.
//
// No React, no stores, no platform calls — so it unit-tests in jsdom with no
// webview (rule 35). Priority is encoded by SHAPE rather than by branching: the
// returned target carries every fact the gesture found, and the item providers
// decide which sections that adds up to. The one exception is spelled out on
// `linkUrl` below.

/** Input types that hold text a caret can cut, paste into and select. */
const TEXT_INPUT_TYPES = new Set(['email', 'number', 'password', 'search', 'tel', 'text', 'url'])

const LOOPBACK_HOSTS = new Set(['0.0.0.0', '127.0.0.1', '::1', '[::1]', 'localhost'])

export interface ContextMenuDomTarget {
  /** The clicked editable, if any. `null` for disabled / readOnly / non-text fields. */
  editable: HTMLElement | null
  /** `href` of the enclosing anchor, AS WRITTEN — never absolutized. `''` for `#`. */
  linkUrl: string
  /** `currentSrc || src` of the clicked image. `''` for a broken/blocked image. */
  imageUrl: string
  /** The click landed on an `<img>` — true even when `imageUrl` is `''`. */
  onImage: boolean
  /** Live document selection text at gesture time, trimmed. */
  selectionText: string
}

/**
 * The editable this element sits in, or null.
 *
 * `readOnly` and `disabled` fields are not editables: a native menu greys every
 * verb there, and offering them enabled would be the "always failing control"
 * the house rules reject. A checkbox or a range slider is an `<input>` with no
 * text, so it is not one either.
 */
export function editableFrom(element: Element | null): HTMLElement | null {
  const field = element?.closest('input, textarea, [contenteditable]') ?? null

  if (!(field instanceof HTMLElement)) {
    return null
  }

  if (field instanceof HTMLInputElement) {
    return field.disabled || field.readOnly || !TEXT_INPUT_TYPES.has(field.type) ? null : field
  }

  if (field instanceof HTMLTextAreaElement) {
    return field.disabled || field.readOnly ? null : field
  }

  // The ATTRIBUTE, not `isContentEditable`: inheritance is already handled by
  // the `closest()` above (the nearest ancestor that declares it wins, so a
  // `contenteditable="false"` island inside an editable correctly reports not
  // editable), and the property is a browser-only computation jsdom never
  // implements — which would make every contenteditable path here untestable.
  return field.getAttribute('contenteditable') === 'false' ? null : field
}

export function resolveDomTarget(element: Element | null): ContextMenuDomTarget {
  const anchor = element?.closest('a[href]') ?? null
  const image = element?.closest('img') ?? null
  const editable = editableFrom(element)
  // `getAttribute`, not `.href`: an absolutized href turns a relative in-app
  // link into an `app://` URL nothing can open, and the label must show what
  // the page actually wrote.
  const href = anchor?.getAttribute('href')?.trim() ?? ''

  return {
    editable,
    // An editable wins the caret verbs over a link wrapping it: inside a field
    // "Open in external browser" is never what the gesture meant, and the four
    // edit verbs are the whole reason this menu exists in a composer.
    imageUrl: image instanceof HTMLImageElement ? image.currentSrc || image.src : '',
    linkUrl: editable || href === '#' || href.startsWith('#') ? '' : href,
    onImage: image !== null,
    selectionText: (window.getSelection()?.toString() ?? '').trim()
  }
}

/** An http(s) URL — the only kind "open in a browser" can mean. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * A URL pointing at this machine's loopback interface.
 *
 * Nothing in v1 renders a row from this: universal is always a remote-gateway
 * client and deliberately has no SSH-forward reach helper, so desktop's "Copy
 * resolved URL" is cut (MJXHRM-478 §10.1). It lives here so MJXHRM-447 — which
 * WILL browse loopback pages — adds a row rather than a subsystem.
 */
export function isLoopbackUrl(url: string): boolean {
  if (!isWebUrl(url)) {
    return false
  }

  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}
