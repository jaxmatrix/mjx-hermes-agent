import { invoke } from '@tauri-apps/api/core'

import { loadSessionCookies, saveSessionCookies } from '@/lib/secure-store'

// Gateway-session persistence across launches (D4/R2b). The reqwest cookie jar
// that carries the OAuth/cloud session lives in Rust and is in-memory only, so
// without this the login is lost on every app restart. We serialize the jar out
// of Rust (`cookies_export`) into the OS keyring, and rehydrate it back in
// (`cookies_import`) once on launch before the first connect.
//
// Both directions are best-effort: a missing keyring (browser dev / non-mobile
// before the D6 desktop-gate flip) simply degrades to no-persistence — the user
// signs in again — never a crash.

/** Serialize the live jar and stash it in the keyring. Call after a successful connect. */
export async function persistSessionCookies(): Promise<void> {
  try {
    const json = await invoke<string>('cookies_export')
    if (json && json.trim()) await saveSessionCookies(json)
  } catch {
    // No Tauri runtime or empty jar — nothing to persist.
  }
}

/** Rehydrate the jar from the keyring. Call once at startup, before connecting. */
export async function restoreSessionCookies(): Promise<void> {
  try {
    const json = await loadSessionCookies()
    if (json && json.trim()) await invoke('cookies_import', { json })
  } catch {
    // No saved session or no runtime — start with an empty jar.
  }
}
