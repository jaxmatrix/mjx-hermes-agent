import { openUrl } from '@tauri-apps/plugin-opener'

// Open a URL in the system browser (Gc6/R11). In a Tauri webview a plain <a>
// would navigate the app away, so links route through here. Guarded: a non-Tauri
// context (browser dev / vitest) falls back to window.open instead of throwing.
export async function openExternalLink(url: string): Promise<void> {
  try {
    await openUrl(url)
  } catch {
    try {
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      /* nothing to do */
    }
  }
}
