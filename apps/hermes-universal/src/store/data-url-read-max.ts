import { translateNow } from '@/i18n'
import { type Codec, persistentAtom } from '@/lib/persisted'

// Size cap for local files this device reads into memory as a data URL
// (composer attach: picker + OS drag-drop). A memory guard, not a model limit —
// the whole file is base64-buffered before it goes anywhere.
//
// WHY IT IS NOT ENFORCED HERE. By the time JS holds the bytes the allocation
// that kills the app has already happened, and on Android the failure mode is
// the system killing the process: no exception to catch, no toast, no chip, the
// draft gone. So the read itself lives in Rust (`data_url_read_max.rs`), which
// refuses on `metadata().len()` before allocating and falls back to a bounded
// read for descriptors that cannot answer up front (an Android SAF `content://`
// fd commonly stats as 0). This module is the UI mirror and the seam every
// caller goes through.
//
// Ported from desktop's split across apps/shared/src/data-url-read-max.ts
// (constants + clamp), src/store/data-url-read-max.ts (the atom) and
// electron/main.ts (the persisted value + the capped read). Universal keeps the
// four numbers HERE rather than importing them: it imports nothing from
// apps/shared, by design. They are duplicated once more in Rust, and both
// copies are pinned by a test asserting the literals so neither can drift alone.
export const DATA_URL_READ_DEFAULT_MAX_MB = 16
export const DATA_URL_READ_MIN_MAX_MB = 1
export const DATA_URL_READ_MAX_MAX_MB = 4096

export function clampDataUrlReadMaxMb(value: unknown): number {
  const parsed = Number(value)

  if (!Number.isFinite(parsed)) {
    return DATA_URL_READ_DEFAULT_MAX_MB
  }

  return Math.min(DATA_URL_READ_MAX_MAX_MB, Math.max(DATA_URL_READ_MIN_MAX_MB, Math.round(parsed)))
}

export function dataUrlReadMaxBytes(maxMb: number): number {
  return clampDataUrlReadMaxMb(maxMb) * 1024 * 1024
}

// The clamp doubles as the codec's sanitizer, so a hand-edited or half-written
// localStorage value reads back as a usable cap rather than NaN or 4 TB.
const maxMbCodec: Codec<number> = {
  decode: raw => clampDataUrlReadMaxMb(raw),
  encode: value => String(clampDataUrlReadMaxMb(value))
}

/**
 * The cap, as the user set it. A device-local preference — it rides
 * `persistentAtom`/localStorage beside keep-awake, translucency and the other
 * client prefs, NOT the gateway config schema: nothing here is sent to the
 * gateway, and two devices talking to one gateway want their own answer (a
 * phone's ceiling is not a workstation's, which is the entire point of the
 * guard). It is not a credential, so it is not in the keyring either.
 */
export const $dataUrlReadMaxMb = persistentAtom<number>(
  'hermes.dataUrlReadMaxMb',
  DATA_URL_READ_DEFAULT_MAX_MB,
  maxMbCodec
)

async function tauriInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return await invoke<T>(command, args)
}

/**
 * Push the preference down to Rust; resolves with the cap actually in force.
 *
 * Rust re-clamps and answers with what it stored, so a localStorage edit past
 * `MAX` cannot lift the real ceiling — the answer is what the atom keeps.
 */
export async function applyDataUrlReadMaxMb(maxMb: number): Promise<number> {
  return clampDataUrlReadMaxMb(await tauriInvoke<number>('set_data_url_read_max', { maxMb }))
}

export function setDataUrlReadMaxMb(maxMb: number): number {
  const next = clampDataUrlReadMaxMb(maxMb)
  $dataUrlReadMaxMb.set(next)

  void applyDataUrlReadMaxMb(next)
    .then(applied => {
      // Only correct the atom when Rust disagreed. Silent otherwise: this is a
      // number the user just typed and echoing it back as a toast is noise.
      if (applied !== next) {
        $dataUrlReadMaxMb.set(applied)
      }
    })
    .catch(() => {
      // No Tauri runtime (tests, a browser preview) — nothing reads local files
      // there either, so there is no cap to be wrong about.
    })

  return next
}

/**
 * Re-assert the persisted cap once at startup.
 *
 * Rust boots at the DEFAULT — the state is a plain atomic, not a file — so
 * without this a device configured to 2 MB would spend the whole session
 * enforcing 16.
 */
export function initDataUrlReadMax(): void {
  void applyDataUrlReadMaxMb($dataUrlReadMaxMb.get()).catch(() => undefined)
}

/** The shape `read_capped_file_base64` rejects with (CappedReadError in Rust). */
interface CappedReadError {
  tooLarge?: boolean
  message?: string
}

function isCappedReadError(value: unknown): value is CappedReadError {
  return typeof value === 'object' && value !== null && 'tooLarge' in value
}

/**
 * Read a local path — or an Android `content://` URI — as a base64 payload,
 * refused in Rust if it is over the cap.
 *
 * Throws with the user-facing reason already in `message`: `notifyError` shows
 * it under the caller's own title, so the toast names the limit in MB and where
 * to raise it instead of saying "could not attach" and leaving the user to
 * guess whether the file, the disk or the gateway was at fault.
 */
export async function readCappedFileBase64(path: string): Promise<string> {
  try {
    return await tauriInvoke<string>('read_capped_file_base64', { path })
  } catch (error) {
    if (isCappedReadError(error) && error.tooLarge) {
      throw new Error(translateNow('composer.attachTooLarge', $dataUrlReadMaxMb.get()))
    }

    throw isCappedReadError(error) && error.message ? new Error(error.message) : error
  }
}
