/**
 * Local file surfaces over Rust `fs_*` / `workspace` / capped data-URL reads
 * (Electron `fs-ipc`, `workspace-cwd`, preview text, attach).
 *
 * `readFileDataUrl` and `dataUrlReadMax`: a file ON THIS DEVICE as a data URL,
 * refused in Rust before it is buffered (`data_url_read_max.rs`).
 *
 * `readFileDataUrlForAttach` uses a fixed 256 MiB ceiling
 * (`read_capped_file_base64_for_attach`), independent of the Settings preview
 * cap — same contract as Electron's `hermes:readFileDataUrlForAttach`.
 *
 * Desktop only asks the bridge for a local file — a gateway's file goes over
 * REST (`lib/desktop-fs.ts`, `isDesktopFsRemoteMode`) and never arrives here.
 *
 * The preview cap is one number with two homes. Electron's main process owns a
 * JSON file; here the webview owns a `localStorage` key and Rust holds the
 * value in force, which boots at the default. So every preview read waits for
 * the persisted value to have been pushed down once, and `set` answers with
 * what Rust actually stored.
 *
 * Project-tree FS + workspace/preview helpers (`readDir`, `gitRoot`, `openDir`,
 * `renamePath`, `writeTextFile`, `trashPath`, `readFileText`,
 * `sanitizeWorkspaceCwd`, `normalizePreviewTarget`) are desktop-only — phones
 * have no local project file manager.
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

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
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
async function localPath(requested: unknown, purpose = PURPOSE): Promise<string> {
  const raw = typeof requested === 'string' ? requested.trim() : ''

  if (!raw || raw.includes('\0')) {
    throw new Error(`${purpose} failed: file path is ${raw ? 'invalid' : 'required'}.`)
  }

  if (/^file:/i.test(raw)) {
    try {
      const decoded = decodeURIComponent(new URL(raw).pathname)

      return /^\/[a-z]:[\\/]/i.test(decoded) ? decoded.slice(1) : decoded
    } catch {
      throw new Error(`${purpose} failed: file URL is invalid.`)
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

const readDir: Bridge['readDir'] = async dirPath => {
  const path = await localPath(dirPath)

  return invokeNative('fs_read_dir', { path })
}

const gitRoot: NonNullable<Bridge['gitRoot']> = async startPath => {
  const path = await localPath(startPath)

  return invokeNative('fs_git_root', { path })
}

const openDir: NonNullable<Bridge['openDir']> = async dirPath => {
  const path = await localPath(dirPath)

  return invokeNative('fs_open_dir', { path })
}

const renamePath: NonNullable<Bridge['renamePath']> = async (targetPath, newName) => {
  const path = await localPath(targetPath)

  return invokeNative('fs_rename', { path, newName })
}

const writeTextFile: NonNullable<Bridge['writeTextFile']> = async (filePath, content) => {
  const path = await localPath(filePath)

  return invokeNative('fs_write_text', { path, content: String(content ?? '') })
}

const trashPath: NonNullable<Bridge['trashPath']> = async targetPath => {
  const path = await localPath(targetPath)

  return invokeNative('fs_trash', { path })
}

const ATTACH_PURPOSE = 'Attachment upload'

const readFileDataUrlForAttach: NonNullable<Bridge['readFileDataUrlForAttach']> = async filePath => {
  const path = await localPath(filePath, ATTACH_PURPOSE)
  const blocked = sensitivePathBlockReason(path)

  if (blocked) {
    throw new Error(`${ATTACH_PURPOSE} blocked: ${blocked}`)
  }

  let base64: string

  try {
    base64 = await invokeNative<string>('read_capped_file_base64_for_attach', { path })
  } catch (error) {
    const refusal = (error && typeof error === 'object' ? error : {}) as CappedReadError

    throw new Error(
      refusal.tooLarge && refusal.message
        ? `${ATTACH_PURPOSE} failed: ${refusal.message}.`
        : `${ATTACH_PURPOSE} failed: file is not readable.`
    )
  }

  const { mediaMime } = await import('@/lib/media')

  return `data:${mediaMime(path)};base64,${base64}`
}

const readFileText: Bridge['readFileText'] = async filePath => {
  const path = await localPath(filePath, 'Text preview')

  return invokeNative('read_file_text', { path })
}

const sanitizeWorkspaceCwd: Bridge['sanitizeWorkspaceCwd'] = async cwd =>
  invokeNative('sanitize_workspace_cwd', { cwd: cwd ?? null })

const normalizePreviewTarget: Bridge['normalizePreviewTarget'] = async (target, baseDir) =>
  invokeNative('normalize_preview_target', {
    target,
    baseDir: baseDir ?? null
  })


export const filesBridge: Pick<
  Bridge,
  'dataUrlReadMax' | 'readFileDataUrl' | 'readFileDataUrlForAttach'
> = {
  dataUrlReadMax,
  readFileDataUrl,
  readFileDataUrlForAttach
}

/** Desktop project-tree FS + workspace/preview — absent on phones (feature-detect). */
export const projectFsBridge: Pick<
  Bridge,
  | 'gitRoot'
  | 'normalizePreviewTarget'
  | 'openDir'
  | 'readDir'
  | 'readFileText'
  | 'renamePath'
  | 'sanitizeWorkspaceCwd'
  | 'trashPath'
  | 'writeTextFile'
> = {
  gitRoot,
  normalizePreviewTarget,
  openDir,
  readDir,
  readFileText,
  renamePath,
  sanitizeWorkspaceCwd,
  trashPath,
  writeTextFile
}

/** Test seam: forget that the cap was pushed. */
export function __resetDataUrlReadMax(): void {
  inForce = null
}
