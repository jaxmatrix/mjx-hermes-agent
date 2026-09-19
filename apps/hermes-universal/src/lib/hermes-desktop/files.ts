/**
 * `readFileDataUrl` and `dataUrlReadMax`: a file ON THIS DEVICE as a data URL,
 * refused in Rust before it is buffered (`data_url_read_max.rs`).
 *
 * Desktop only asks the bridge for a local file — a gateway's file goes over
 * REST (`lib/desktop-fs.ts`, `isDesktopFsRemoteMode`) and never arrives here.
 *
 * The cap is one number with two homes, as it was before the resync. Electron's
 * main process owns a JSON file; here the webview owns a `localStorage` key and
 * Rust holds the value in force, which boots at the default. So every read
 * waits for the persisted value to have been pushed down once, and `set`
 * answers with what Rust actually stored.
 *
 * `readFileDataUrlForAttach` stays ABSENT: Electron reads attachments under a
 * fixed 256 MiB cap, and `read_capped_file_base64` has one cap — the user's. Its
 * caller falls back to `readFileDataUrl`, which is the limit universal's attach
 * path always had (and the one a phone needs).
 */

import { clampDataUrlReadMaxMb, DATA_URL_READ_DEFAULT_MAX_MB } from '@hermes/shared'

import { readKey, writeKey } from '@/lib/storage'

import { sensitivePathBlockReason } from './sensitive-path'

type Bridge = NonNullable<typeof window.hermesDesktop>
type DataUrlReadMax = NonNullable<Bridge['dataUrlReadMax']>

/** Unchanged from the pre-resync store, so a tuned cap survives the upgrade. */
const MAX_MB_KEY = 'hermes.dataUrlReadMaxMb'
const PURPOSE = 'File preview'

/** `read_capped_file_base64`'s rejection (`CappedReadError`). */
interface CappedReadError {
  message?: string
  tooLarge?: boolean
}

async function invokeNative<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

function persistedMaxMb(): number {
  const raw = readKey(MAX_MB_KEY)

  return raw === null ? DATA_URL_READ_DEFAULT_MAX_MB : clampDataUrlReadMaxMb(raw)
}

const answer = (maxMb: number) => ({
  defaultMaxMb: DATA_URL_READ_DEFAULT_MAX_MB,
  maxBytes: maxMb * 1024 * 1024,
  maxMb
})

/** Rust re-clamps and answers with what it stored. */
const pushDown = async (maxMb: number): Promise<number> =>
  clampDataUrlReadMaxMb(await invokeNative<number>('set_data_url_read_max', { maxMb }))

let inForce: null | Promise<number> = null

/** The persisted cap, in force in Rust. A failed push is retried by the next ask. */
function capInForce(): Promise<number> {
  if (!inForce) {
    const pushed = pushDown(persistedMaxMb())

    inForce = pushed
    pushed.catch(() => {
      if (inForce === pushed) {
        inForce = null
      }
    })
  }

  return inForce
}

const dataUrlReadMax: DataUrlReadMax = {
  get: async () => answer(await capInForce()),

  set: async maxMb => {
    const pushed = pushDown(clampDataUrlReadMaxMb(maxMb))

    inForce = pushed

    const applied = await pushed

    writeKey(MAX_MB_KEY, String(applied))

    return answer(applied)
  }
}

/** Electron's `resolveRequestedPathForIpc`, for what a renderer actually sends:
 *  a path, a `file:` URL, or `~/…`. An Android `content://` URI passes through —
 *  Rust is what can open one. */
async function localPath(requested: unknown): Promise<string> {
  const raw = typeof requested === 'string' ? requested.trim() : ''

  if (!raw || raw.includes('\0')) {
    throw new Error(`${PURPOSE} failed: file path is ${raw ? 'invalid' : 'required'}.`)
  }

  if (/^file:/i.test(raw)) {
    try {
      const decoded = decodeURIComponent(new URL(raw).pathname)

      return /^\/[a-z]:[\\/]/i.test(decoded) ? decoded.slice(1) : decoded
    } catch {
      throw new Error(`${PURPOSE} failed: file URL is invalid.`)
    }
  }

  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    const { homeDir, join } = await import('@tauri-apps/api/path')

    return join(await homeDir(), raw.slice(1))
  }

  return raw
}

const readFileDataUrl: Bridge['readFileDataUrl'] = async filePath => {
  const path = await localPath(filePath)
  const blocked = sensitivePathBlockReason(path)

  if (blocked) {
    throw new Error(`${PURPOSE} blocked: ${blocked}`)
  }

  await capInForce()

  let base64: string

  try {
    base64 = await invokeNative<string>('read_capped_file_base64', { path })
  } catch (error) {
    const refusal = (error && typeof error === 'object' ? error : {}) as CappedReadError

    // Only the size refusal is quoted: desktop parses `limit N bytes` out of it
    // (`friendlyRemoteAttachError`), and it names no path. Any other message is
    // the OS's, which does.
    throw new Error(
      refusal.tooLarge && refusal.message
        ? `${PURPOSE} failed: ${refusal.message}.`
        : `${PURPOSE} failed: file is not readable.`
    )
  }

  // Dynamic: `lib/media` reaches the session store. Electron's table, same keys.
  const { mediaMime } = await import('@/lib/media')

  return `data:${mediaMime(path)};base64,${base64}`
}

export const filesBridge: Pick<Bridge, 'dataUrlReadMax' | 'readFileDataUrl'> = { dataUrlReadMax, readFileDataUrl }

/** Test seam: forget that the cap was pushed. */
export function __resetDataUrlReadMax(): void {
  inForce = null
}
