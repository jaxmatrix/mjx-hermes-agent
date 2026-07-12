// Lightweight persistence over the webview's localStorage. Used for the last
// backend URL/token so reconnect is one tap, and as the backend for
// persistentAtom (./persisted).
//
// FIXME(D2): NOT secure storage — values are plaintext. Move credentials
// (url/token/username/password in store/connection.ts) to secure storage
// (Android Keystore) via a Tauri secure-store command. This helper stays fine
// for non-secret UI prefs only.

// --- null-aware choke point (backs persistentAtom in ./persisted) ---

// Returns the raw stored string, or null when absent (distinct from ''). Ported
// to match the desktop storage.ts contract persistentAtom expects.
export function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

// Writes a value, or removes the key when value is null.
export function writeKey(key: string, value: string | null): void {
  if (value === null) {
    removeKey(key)
    return
  }

  saveString(key, value)
}

export function loadString(key: string, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function saveString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage disabled — non-fatal
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // non-fatal
  }
}
