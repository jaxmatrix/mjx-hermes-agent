// Lightweight persistence over the webview's localStorage, and the backend for
// persistentAtom (./persisted). NON-SECRET values only — the last backend URL
// and username for prefill, plus UI prefs. Credentials (token/password) live in
// the OS keyring instead (see @/lib/secure-store).

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
