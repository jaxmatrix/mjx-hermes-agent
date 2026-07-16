import { IS_TAURI } from '@/lib/platform'

// Open a URL in the system browser (Gc6/R11). In a Tauri webview a plain <a> or
// window.open would navigate the app away (or no-op), so links route through a
// native Rust command (`open_external`) that calls the opener plugin's Rust API —
// this bypasses the JS opener ACL/scope that was silently failing. Off Tauri
// (plain-web dev / vitest) it falls back to window.open.
export async function openExternalLink(url: string): Promise<void> {
  if (IS_TAURI) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_external', { url })
      return
    } catch {
      // Native command unavailable — fall through to window.open.
    }
  }

  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    /* nothing to do */
  }
}
