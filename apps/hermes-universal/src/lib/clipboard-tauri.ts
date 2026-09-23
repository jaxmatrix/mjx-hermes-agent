// Universal's OS clipboard path — the Tauri half of desktop's clipboard bridge.
//
// Desktop routes clipboard text through `window.hermesDesktop.writeClipboard` /
// `readClipboard` (Electron main-process IPC): `lib/clipboard.ts` shims
// `navigator.clipboard.writeText` onto it at boot, `components/ui/copy-button.tsx`
// (`writeClipboardText`) calls it first, and pastes read through it. Those files
// are desktop's, verbatim, so universal supplies the bridge members instead of
// its own call-site seam (`lib/hermes-desktop/index.ts` installs them).
//
// Why the OS path matters here: universal renders in WebKitGTK on the Linux
// desktop, not Chromium (MJXHRM-415). WebKitGTK gates the async Clipboard API far
// more tightly than Chromium — `readText` is refused outright in cases Chromium
// allows, and a write outside a user gesture can be dropped — so a call that
// reaches only `navigator.clipboard` silently does nothing on the platform we
// ship. The Tauri clipboard-manager plugin goes through the OS instead.
//
// Order is always: plugin first, web API second. The web API stays as the
// fallback for targets without the plugin (browser dev, `npm run dev`). The
// plugin call itself is inside the try: without `window.__TAURI_INTERNALS__` the
// module still IMPORTS fine and only `invoke` rejects, so guarding the import
// alone would not catch it.
//
// The capability chain behind the plugin lives in
// `src-tauri/capabilities/default.json`: `clipboard-manager:allow-read-text` and
// `allow-write-text`, granted to every window label the app opens. A missing
// grant rejects at `invoke`, which lands in the same catch as "plugin absent" and
// degrades to the web API — so the grant list is load-bearing: an unlisted window
// label loses the OS path without any visible signal.
//
// A static LEAF on purpose: `lib/hermes-desktop/install` evaluates it before any
// renderer module (see `install.test.ts`).

/**
 * Read text from the system clipboard.
 *
 * Returns '' rather than throwing: the caller is a paste, and a paste the
 * platform refuses must be a no-op, not an error dialog over a shell prompt.
 */
export async function readClipboardText(): Promise<string> {
  try {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager')

    return (await readText()) ?? ''
  } catch {
    // Plugin unavailable or refused — fall through to the webview's own API.
  }

  try {
    return (await navigator.clipboard?.readText?.()) ?? ''
  } catch {
    return ''
  }
}

type DesktopBridge = NonNullable<typeof window.hermesDesktop>

/**
 * The `writeClipboard` / `readClipboard` members of `window.hermesDesktop`.
 *
 * The webview's own `writeText` is captured HERE, at creation: desktop's
 * `installClipboardShim` later replaces `navigator.clipboard.writeText` with a
 * function that calls `writeClipboard`, so falling back through the live
 * property would recurse. The bridge installs first (`main.tsx` import order).
 *
 * `writeClipboard` throws when neither path is available, so a copy button can
 * show its error state.
 */
export function createClipboardBridge(): Pick<DesktopBridge, 'readClipboard' | 'writeClipboard'> {
  const webWriteText =
    typeof navigator === 'undefined' ? undefined : navigator.clipboard?.writeText?.bind(navigator.clipboard)

  return {
    readClipboard: readClipboardText,
    writeClipboard: async text => {
      try {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')

        await writeText(text)

        return true
      } catch {
        // Plugin unavailable or refused — fall through to the webview's own API.
      }

      if (webWriteText) {
        await webWriteText(text)

        return true
      }

      throw new Error('Clipboard API is unavailable')
    }
  }
}
