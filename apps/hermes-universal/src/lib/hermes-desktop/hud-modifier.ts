/**
 * `hermesDesktop.hudModifier` — opt-in Ctrl/Alt tap → summon HUD.
 *
 * Electron SoT: `hud-modifier.ts` + native helpers. Rust: `hud_modifier.rs`.
 */

import { IS_DESKTOP } from '@/lib/platform'

type Bridge = NonNullable<typeof window.hermesDesktop>
type HudModifier = NonNullable<Bridge['hudModifier']>

const STATUS_EVENT = 'hermes://hud-modifier-status'

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

function listenEvent<T>(event: string, callback: (payload: T) => void): () => void {
  let stop: (() => void) | undefined
  let cancelled = false

  void import('@tauri-apps/api/event')
    .then(({ listen }) => {
      if (cancelled) {
        return undefined
      }

      return listen<T>(event, message => callback(message.payload))
    })
    .then(unlisten => {
      if (!unlisten) {
        return
      }

      if (cancelled) {
        unlisten()
      } else {
        stop = unlisten
      }
    })
    .catch(() => undefined)

  return () => {
    cancelled = true
    stop?.()
  }
}

const getSettings: HudModifier['getSettings'] = () =>
  invokeNative<Awaited<ReturnType<HudModifier['getSettings']>>>('hud_modifier_settings_get')

const setEnabled: HudModifier['setEnabled'] = enabled =>
  invokeNative<Awaited<ReturnType<HudModifier['setEnabled']>>>('hud_modifier_settings_set', {
    enabled: Boolean(enabled)
  })

const openPermissionSettings: HudModifier['openPermissionSettings'] = () =>
  invokeNative<void>('hud_modifier_open_permission')

const onStatus: HudModifier['onStatus'] = callback =>
  listenEvent<{ enabled: boolean; state: string; reason?: string }>(STATUS_EVENT, status => {
    if (status && typeof status === 'object' && typeof status.enabled === 'boolean') {
      callback(status as Parameters<HudModifier['onStatus']>[0] extends (s: infer S) => void ? S : never)
    }
  })

const api: HudModifier = {
  getSettings,
  setEnabled,
  openPermissionSettings,
  onStatus
}

export const hudModifierBridge: Pick<Bridge, 'hudModifier'> | Record<string, never> = IS_DESKTOP
  ? { hudModifier: api }
  : {}
