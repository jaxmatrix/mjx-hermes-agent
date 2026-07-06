// Lightweight persistence over the webview's localStorage. Used for the last
// backend URL/token so reconnect is one tap. NOTE: this is NOT secure storage —
// the token is stored in plaintext. Moving credentials to the Android keystore
// (via a Tauri secure-store plugin) is a tracked follow-up before ship.

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
