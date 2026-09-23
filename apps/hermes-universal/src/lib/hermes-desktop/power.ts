/**
 * `setKeepAwake`, over Rust's one sleep inhibitor (`keep_awake.rs`).
 *
 * Desktop's store (`store/keep-awake.ts`) owns the preference and calls this on
 * every change — and once at boot, because a nanostores `subscribe` fires
 * immediately, which is what re-arms the inhibitor after a relaunch.
 *
 * Electron's `powerSaveBlocker` cannot refuse. An OS can: there is no logind
 * under WSL or on a non-systemd distro, and a sandboxed build may not reach the
 * system bus. `set_keep_awake` answers with what is HELD, so a refused arm turns
 * the switch back off and says so — a switch that reads "on" over a machine
 * free to sleep is the one outcome this lever must not have. Only an arm is
 * corrected: correcting a release as well could bounce between the two forever.
 *
 * Desktop only. A phone sleeps on its own terms, Rust answers
 * `unsupported_platform` there, and the caller optional-chains the member.
 */

import type * as TauriCore from '@tauri-apps/api/core'

import { translateNow } from '@/i18n/runtime'

type Bridge = NonNullable<typeof window.hermesDesktop>

/** Only the newest ask may correct the switch. */
let generation = 0

let core: null | Promise<typeof TauriCore> = null

async function refused(error: unknown): Promise<void> {
  // Dynamic: both stores are outside the install graph.
  const [{ setKeepAwake }, { notifyError }] = await Promise.all([
    import('@/store/keep-awake'),
    import('@/store/notifications')
  ])

  setKeepAwake(false)
  notifyError(error, translateNow('settings.config.keepAwakeFailed'))
}

const setKeepAwake: NonNullable<Bridge['setKeepAwake']> = on => {
  const want = Boolean(on)
  const mine = ++generation

  core ??= import('@tauri-apps/api/core')

  void core
    .then(({ invoke }) => invoke<boolean>('set_keep_awake', { on: want }))
    .then(held => {
      if (want && !held && mine === generation) {
        return refused(new Error('The system refused the sleep inhibitor'))
      }
    })
    .catch((error: unknown) => (want && mine === generation ? refused(error) : undefined))
    .catch(() => undefined)
}

export const powerBridge: Pick<Bridge, 'setKeepAwake'> = { setKeepAwake }
