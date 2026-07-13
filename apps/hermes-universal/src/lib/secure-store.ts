import { deletePassword, getPassword, setPassword } from 'tauri-plugin-keyring-api'

import { IS_MOBILE } from '@/lib/platform'

// Secure credential storage (D1). Isolates the OS keyring
// (tauri-plugin-keyring, Android Keystore-backed) behind a small typed API so
// the rest of the app never touches the plugin directly. Silent (no biometric
// prompt) — chosen over the biometric keystore plugin, whose only published
// build was broken.
//
// FIXME(D): keyring is silent; if we later want biometric-gated retrieval, wrap
// these reads with tauri-plugin-biometric authenticate() first.

const SERVICE = 'hermes-mobile'

export interface Secrets {
  token?: string
  password?: string
}

// keyring stores one string per (service, user). We keep token and password as
// two named entries under the shared service.
type SecretKey = 'token' | 'password'

// keyring calls reject when there is no Tauri runtime (browser dev / vitest) or
// no OS keyring available; treat any failure as "unavailable" so callers can
// degrade to no-persistence rather than crashing (never fall back to plaintext).
async function safe<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  if (!IS_MOBILE) return fallback
  try {
    return await op()
  } catch {
    return fallback
  }
}

async function writeKey(key: SecretKey, value: string | undefined): Promise<void> {
  if (value) {
    await setPassword(SERVICE, key, value)
  } else {
    await deletePassword(SERVICE, key).catch(() => {})
  }
}

/** True when the OS keyring is reachable (mobile + a successful probe write). */
export async function secureStoreAvailable(): Promise<boolean> {
  return safe(async () => {
    await getPassword(SERVICE, 'token') // reachable if this resolves (value may be null)
    return true
  }, false)
}

/** Persist secrets. Returns false if the keyring is unavailable (nothing stored). */
export async function saveSecrets(secrets: Secrets): Promise<boolean> {
  return safe(async () => {
    await writeKey('token', secrets.token)
    await writeKey('password', secrets.password)
    return true
  }, false)
}

/** Read secrets, or null when the keyring is unavailable / nothing saved. */
export async function loadSecrets(): Promise<Secrets | null> {
  return safe(async () => {
    const [token, password] = await Promise.all([getPassword(SERVICE, 'token'), getPassword(SERVICE, 'password')])
    if (!token && !password) return null
    return { token: token ?? undefined, password: password ?? undefined }
  }, null)
}

/** Remove all stored secrets (e.g. on disconnect/forget). */
export async function clearSecrets(): Promise<void> {
  await safe(async () => {
    await writeKey('token', undefined)
    await writeKey('password', undefined)
    return undefined
  }, undefined)
}
