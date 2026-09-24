/**
 * `hermesDesktop.updates` / `getVersion` / `relaunchApp` over Rust
 * `update_*` + `relaunch_app`.
 *
 * Electron's updater tracks git branch distance (`behind`, commits). Universal
 * tracks signed GitHub releases (`update_check`). The bridge maps the release
 * shape onto `DesktopUpdateStatus` so `store/updates.ts` keeps working: an
 * available release → `updateAvailable` with `behind: null` (count unknowable).
 */

import type {
  DesktopUpdateApplyOptions,
  DesktopUpdateApplyResult,
  DesktopUpdateProgress,
  DesktopUpdateStatus,
  DesktopVersionInfo
} from '@/global'
import { IS_DESKTOP } from '@/lib/platform'
import type { UpdateProgress, UpdateStatus } from '@/lib/updates'

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

function mapStatus(raw: UpdateStatus): DesktopUpdateStatus {
  const disabled = raw.source === 'disabled'
  const available = Boolean(raw.updateAvailable)

  return {
    supported: !disabled,
    updateAvailable: available,
    // Release-channel distance is not a commit count — null means "available,
    // count unknown" (same convention as Electron's shallow-clone case).
    behind: available ? null : 0,
    currentVersion: raw.currentVersion,
    targetSha: raw.latestVersion ? `v${raw.latestVersion}` : undefined,
    message: raw.reason ?? undefined,
    reason: raw.reason ?? undefined,
    fetchedAt: raw.checkedAtMs,
    branch: 'release'
  }
}

const check: Bridge['updates']['check'] = async (opts = {}) => {
  const raw = await invokeNative<UpdateStatus>('update_check', { force: Boolean(opts.force) })

  return mapStatus(raw)
}

const apply: Bridge['updates']['apply'] = async (_opts: DesktopUpdateApplyOptions = {}) => {
  try {
    // Never returns on success — the process restarts after install.
    await invokeNative('update_install')

    return { ok: true, guiUpdated: true, handedOff: true } satisfies DesktopUpdateApplyResult
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (/unsupported_platform|checks_disabled|no update/i.test(message)) {
      return {
        ok: false,
        manual: true,
        command: 'Open the release / store page from Settings → About',
        message
      }
    }

    return { ok: false, error: 'apply-failed', message }
  }
}

/** Universal has no git update branch — a fixed release channel fills the API. */
const getBranch: Bridge['updates']['getBranch'] = async () => ({ branch: 'release' })

const setBranch: Bridge['updates']['setBranch'] = async name => ({
  branch: String(name || 'release').trim() || 'release'
})

const onProgress: Bridge['updates']['onProgress'] = callback => {
  let stop: (() => void) | undefined
  let cancelled = false

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')

      const unlisten = await listen<UpdateProgress>('update://progress', event => {
        const { downloaded, total } = event.payload

        const percent =
          typeof total === 'number' && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null

        const payload: DesktopUpdateProgress = {
          stage: 'fetch',
          message: percent == null ? 'Downloading update…' : `Downloading update… ${percent}%`,
          percent,
          error: null,
          at: Date.now()
        }

        callback(payload)
      })

      if (cancelled) {
        unlisten()
      } else {
        stop = unlisten
      }
    } catch {
      // No Tauri runtime / event bus — progress stays silent.
    }
  })()

  return () => {
    cancelled = true
    stop?.()
  }
}

const getVersion: NonNullable<Bridge['getVersion']> = async () => {
  const { getVersion: appVersion } = await import('@tauri-apps/api/app')
  const { platform } = await import('@tauri-apps/plugin-os')

  const info: DesktopVersionInfo = {
    appVersion: await appVersion(),
    electronVersion: '',
    nodeVersion: '',
    platform: platform(),
    hermesRoot: ''
  }

  return info
}

const relaunchApp: NonNullable<Bridge['relaunchApp']> = async () => {
  await invokeNative('relaunch_app')
}

export const updatesBridge: Pick<Bridge, 'updates' | 'getVersion' | 'relaunchApp'> = {
  updates: {
    check,
    apply,
    getBranch,
    setBranch,
    onProgress
  },
  getVersion,
  // About "Restart" is a desktop affordance; phones don't expose it.
  ...(IS_DESKTOP ? { relaunchApp } : {})
}
