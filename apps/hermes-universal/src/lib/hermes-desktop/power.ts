/**
 * Power + battery over Rust (`keep_awake.rs`, `host_facts.rs`).
 *
 * `setKeepAwake`: sleep inhibitor (see prior docs).
 * `getOnBattery` / `onBatteryChanged`: Electron powerMonitor mirror — seeds
 * `store/power.ts` and stretches backstop polls on battery.
 */

import type * as TauriCore from '@tauri-apps/api/core'

import { translateNow } from '@/i18n/runtime'

type Bridge = NonNullable<typeof window.hermesDesktop>

const BATTERY_EVENT = 'hermes://power-battery'

/** Only the newest ask may correct the switch. */
let generation = 0

let core: null | Promise<typeof TauriCore> = null

async function refused(error: unknown): Promise<void> {
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

const getOnBattery: NonNullable<Bridge['getOnBattery']> = async () => {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<boolean>('get_on_battery')
}

const onBatteryChanged: NonNullable<Bridge['onBatteryChanged']> = callback => {
  let stopped = false
  let unlisten: (() => void) | undefined

  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<boolean>(BATTERY_EVENT, event => callback(Boolean(event.payload))))
    .then(off => {
      if (stopped) {
        off()
      } else {
        unlisten = off
      }
    })
    .catch(() => {})

  return () => {
    stopped = true
    unlisten?.()
  }
}

export const powerBridge: Pick<Bridge, 'getOnBattery' | 'onBatteryChanged' | 'setKeepAwake'> = {
  getOnBattery,
  onBatteryChanged,
  setKeepAwake
}
