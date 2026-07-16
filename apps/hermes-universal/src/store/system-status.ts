import { getVersion } from '@tauri-apps/api/app'

import { translateNow } from '@/i18n'
import { runAction } from '@/lib/action-poll'
import { evaluateRuntimeReadiness, type RuntimeReadinessResult } from '@/lib/runtime-readiness'
import { getStatus, restartGateway } from '@/hermes'
import { atom, onMount } from '@/store/atom'
import { $gatewayState, requestGateway } from '@/store/gateway'
import { notify } from '@/store/notifications'
import type { StatusResponse } from '@/types/hermes'

// Backs the statusbar gateway-health item + panel. Desktop assembled these from a
// `use-status-snapshot` hook + `store/system-actions`; the universal remote client
// has the raw pieces (getStatus / restartGateway+runAction / the runtime-readiness
// RPCs) but no aggregate atom, so this is the small store that owns them.

export const $statusSnapshot = atom<StatusResponse | null>(null)
export const $inferenceStatus = atom<RuntimeReadinessResult | null>(null)
export const $gatewayRestarting = atom(false)
export const $appVersion = atom<string | null>(null)

// Health poll cadence while the statusbar is mounted. Modest: this only drives an
// indicator, and readiness runs `setup.runtime_check` (a provider resolution).
const POLL_MS = 30_000

async function refreshSystemStatus(): Promise<void> {
  if ($gatewayState.get() !== 'open') return

  try {
    $statusSnapshot.set(await getStatus())
  } catch {
    /* leave the prior snapshot */
  }

  try {
    $inferenceStatus.set(await evaluateRuntimeReadiness(requestGateway))
  } catch {
    $inferenceStatus.set(null)
  }
}

let appVersionLoaded = false

// Poll only while something (the statusbar) subscribes. Also refresh the instant
// the socket opens so the indicator isn't stuck on the last-known state.
onMount($statusSnapshot, () => {
  if (!appVersionLoaded) {
    appVersionLoaded = true
    void getVersion()
      .then(v => $appVersion.set(v))
      .catch(() => {})
  }

  void refreshSystemStatus()
  const timer = window.setInterval(() => void refreshSystemStatus(), POLL_MS)
  const unsubscribe = $gatewayState.listen(state => {
    if (state === 'open') void refreshSystemStatus()
  })

  return () => {
    window.clearInterval(timer)
    unsubscribe()
  }
})

/** Restart the gateway; surfaces progress via the statusbar spinner + a toast. */
export async function runGatewayRestart(): Promise<void> {
  if ($gatewayRestarting.get()) return
  $gatewayRestarting.set(true)
  try {
    const { ok } = await runAction(() => restartGateway())
    notify({
      kind: ok ? 'success' : 'warning',
      message: ok ? translateNow('commandCenter.actionDone') : translateNow('commandCenter.gatewayRestartFailed')
    })
    await refreshSystemStatus()
  } finally {
    $gatewayRestarting.set(false)
  }
}
