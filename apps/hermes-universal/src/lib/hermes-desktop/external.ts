/**
 * `openExternal`, `revealPath` and `fetchLinkTitle`: what leaves the app for the
 * OS, over the Rust commands that already own each door.
 *
 * `open_external` is the only working way out (`lib.rs`): the opener plugin's JS
 * `openUrl` is ACL-scoped to an empty allow-list, and the Rust-internal call is
 * not scope-checked at all. That is also why the scheme rule lives HERE — Rust
 * hands whatever it is given to the OS. The rule is Electron's
 * (`openExternalUrl`, `electron/main.ts`): `http:`, `https:`, `mailto:`, and a
 * `file:` that is opened as a file. Anything else is refused with Electron's own
 * error, so a `javascript:` or an installed app's scheme in model output never
 * reaches a handler.
 *
 * A `file:` URL names a path on the machine the BACKEND runs on. Electron opens
 * it blindly, which on a remote connection means opening whatever happens to
 * sit at that path on this disk. Universal never did — before the resync a
 * gateway file was downloaded, never opened in place — so a `file:` is handed to
 * the OS only where the path is this machine's: a desktop window whose primary
 * connection is local.
 *
 * No message here carries the URL or the path: both end up in toasts and logs.
 */

import { IS_DESKTOP } from '@/lib/platform'

type Bridge = NonNullable<typeof window.hermesDesktop>

const INVALID_URL = 'Invalid external URL'
const REMOTE_FILE = 'This file is on the gateway, not on this device'
const OPEN_FAILED = 'The system could not open this link'

const WEB_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

async function invokeNative<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

/** `file:///home/a%20b` → `/home/a b`; `file:///C:/x` → `C:/x`. */
function localPathOf(url: URL): null | string {
  let decoded: string

  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return null
  }

  if (!decoded || decoded.includes('\0')) {
    return null
  }

  return /^\/[a-z]:[\\/]/i.test(decoded) ? decoded.slice(1) : decoded
}

/** Whether a path the backend names is a path on this disk. */
async function backendIsThisMachine(): Promise<boolean> {
  if (!IS_DESKTOP) {
    return false
  }

  // Dynamic: the session store reaches `@/hermes`.
  const { $connection } = await import('@/store/session')

  return $connection.get()?.mode === 'local'
}

async function openLocalFile(url: URL): Promise<void> {
  const path = localPathOf(url)

  if (!path) {
    throw new Error(INVALID_URL)
  }

  if (!(await backendIsThisMachine())) {
    throw new Error(REMOTE_FILE)
  }

  try {
    await invokeNative('open_external', { url: url.toString() })
  } catch {
    // Electron's fallback for a type the OS has no handler for: show it instead.
    try {
      await invokeNative('reveal_in_file_manager', { path })
    } catch {
      throw new Error(OPEN_FAILED)
    }
  }
}

const openExternal: Bridge['openExternal'] = async url => {
  let parsed: URL

  try {
    parsed = new URL(String(url ?? '').trim())
  } catch {
    throw new Error(INVALID_URL)
  }

  if (parsed.protocol === 'file:') {
    return openLocalFile(parsed)
  }

  if (!WEB_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(INVALID_URL)
  }

  try {
    await invokeNative('open_external', { url: parsed.toString() })
  } catch {
    // Rust's error text is the opener's, which can quote the URL.
    throw new Error(OPEN_FAILED)
  }
}

/** Electron's `hermes:fs:reveal`: whether the file manager took it. */
const revealPath: NonNullable<Bridge['revealPath']> = async path => {
  const target = String(path ?? '').trim()

  if (!target) {
    return false
  }

  try {
    await invokeNative('reveal_in_file_manager', { path: target })

    return true
  } catch {
    return false
  }
}

/** Rust answers `''` for anything it will not or cannot read (`link_title.rs`). */
const fetchLinkTitle: Bridge['fetchLinkTitle'] = url => invokeNative<string>('fetch_link_title', { url })

export const externalBridge: Pick<Bridge, 'fetchLinkTitle' | 'openExternal'> = { fetchLinkTitle, openExternal }

/** A phone has no file manager to reveal into; the callers feature-detect. */
export const revealBridge: Pick<Bridge, 'revealPath'> = { revealPath }
