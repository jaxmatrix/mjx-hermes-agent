import type { UpdateProgress, UpdateStatus } from '@/lib/updates'
import { checkAppUpdate, installAppUpdate, onUpdateProgress } from '@/lib/updates'
import { atom } from '@/store/atom'

// App-update state (MJX-6). Deliberately pull-only: the About page checks once
// on mount and on "Check now" — there is no background poller, because the
// native side already caches a result for 6h and nothing outside About consumes
// this. `$appUpdateFailed` is separate from a status carrying `reason` so the UI
// can tell "the command didn't answer" from "the store didn't know".

export const $appUpdate = atom<null | UpdateStatus>(null)
export const $appUpdateChecking = atom(false)
export const $appUpdateFailed = atom(false)

// Self-install (MJXHRM-144). A successful install never resolves — the native
// side restarts the process out from under us — so `$appUpdateInstalling` is
// only ever cleared by a failure. That is deliberate: the button must not
// flicker back to "Update now" while the new bundle is being swapped in.
export const $appUpdateInstalling = atom(false)
export const $appUpdateProgress = atom<null | UpdateProgress>(null)
export const $appUpdateInstallError = atom<null | string>(null)

let inflight: null | Promise<null | UpdateStatus> = null
let unlistenProgress: null | (() => void) = null

/**
 * Run a check, deduping concurrent callers (mount + a quick "Check now" tap
 * would otherwise race and leave the spinner stuck). Resolves to the status, or
 * null when the native command is unavailable (plain-web dev / vitest).
 */
export function runUpdateCheck(force = false): Promise<null | UpdateStatus> {
  if (inflight) {
    return inflight
  }

  $appUpdateChecking.set(true)

  inflight = checkAppUpdate(force)
    .then(status => {
      $appUpdate.set(status)
      $appUpdateFailed.set(status === null)

      return status
    })
    .catch(() => {
      $appUpdateFailed.set(true)

      return null
    })
    .finally(() => {
      inflight = null
      $appUpdateChecking.set(false)
    })

  return inflight
}

/**
 * Download, verify and install the published update.
 *
 * Only resolves when something went wrong — the success path ends in a process
 * restart. The progress listener is attached before the command is invoked so
 * the first chunks aren't missed, and torn down on failure.
 */
export async function runUpdateInstall(): Promise<void> {
  if ($appUpdateInstalling.get()) {
    return
  }

  $appUpdateInstalling.set(true)
  $appUpdateInstallError.set(null)
  $appUpdateProgress.set({ downloaded: 0, total: null })

  unlistenProgress = await onUpdateProgress(progress => $appUpdateProgress.set(progress))

  try {
    await installAppUpdate()
  } catch (error) {
    $appUpdateInstallError.set(error instanceof Error ? error.message : String(error))
    $appUpdateInstalling.set(false)
    $appUpdateProgress.set(null)
    unlistenProgress?.()
    unlistenProgress = null
  }
}

/** Test seam — drop cached state between cases. */
export function __resetUpdateState(): void {
  inflight = null
  unlistenProgress?.()
  unlistenProgress = null
  $appUpdate.set(null)
  $appUpdateChecking.set(false)
  $appUpdateFailed.set(false)
  $appUpdateInstalling.set(false)
  $appUpdateProgress.set(null)
  $appUpdateInstallError.set(null)
}
