/**
 * Tauri native app update atoms (MJX-6). Desktop Electron uses `store/updates.ts`
 * for git-based self-update; universal About/settings context menu uses the Rust
 * `update_check` / `update_install` IPC instead. Protected — do not merge into
 * desktop AUTO `store/updates.ts`.
 */

import { atom } from 'nanostores'

import {
  checkAppUpdate,
  installAppUpdate,
  onUpdateProgress,
  type UpdateProgress,
  type UpdateStatus
} from '@/lib/updates'

export const $appUpdate = atom<UpdateStatus | null>(null)
export const $appUpdateChecking = atom(false)
export const $appUpdateFailed = atom(false)
export const $appUpdateInstalling = atom(false)
export const $appUpdateInstallError = atom<string | null>(null)
export const $appUpdateProgress = atom<UpdateProgress | null>(null)

let progressUnsub: (() => void) | null = null

export async function runUpdateCheck(force = false): Promise<UpdateStatus | null> {
  $appUpdateChecking.set(true)
  $appUpdateFailed.set(false)

  try {
    const status = await checkAppUpdate(force)

    $appUpdate.set(status)

    if (status?.reason === 'unreachable' || status?.reason === 'unparsed') {
      $appUpdateFailed.set(true)
    }

    return status
  } catch {
    $appUpdateFailed.set(true)

    return null
  } finally {
    $appUpdateChecking.set(false)
  }
}

export async function runUpdateInstall(): Promise<void> {
  $appUpdateInstalling.set(true)
  $appUpdateInstallError.set(null)
  $appUpdateProgress.set(null)

  progressUnsub?.()
  progressUnsub = await onUpdateProgress(progress => $appUpdateProgress.set(progress))

  try {
    await installAppUpdate()
  } catch (error) {
    $appUpdateInstallError.set(error instanceof Error ? error.message : String(error))
    $appUpdateInstalling.set(false)
    progressUnsub?.()
    progressUnsub = null
  }
}

/** Test seam — reset all Tauri update atoms between cases. */
export function __resetUpdateState(): void {
  progressUnsub?.()
  progressUnsub = null
  $appUpdate.set(null)
  $appUpdateChecking.set(false)
  $appUpdateFailed.set(false)
  $appUpdateInstalling.set(false)
  $appUpdateInstallError.set(null)
  $appUpdateProgress.set(null)
}
