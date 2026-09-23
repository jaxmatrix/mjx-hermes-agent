/**
 * `hermesDesktop.screenshot` — macOS gesture + capture (unavailable elsewhere).
 *
 * Electron SoT: `command-screenshot.ts`. Rust: `screenshot.rs`.
 */

import { IS_DESKTOP } from '@/lib/platform'

type Bridge = NonNullable<typeof window.hermesDesktop>
type Screenshot = NonNullable<Bridge['screenshot']>

const STATUS_EVENT = 'hermes://screenshot-status'
const REQUEST_EVENT = 'hermes://screenshot-request'

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

const getSettings: Screenshot['getSettings'] = () =>
  invokeNative<Awaited<ReturnType<Screenshot['getSettings']>>>('screenshot_settings_get')

const setEnabled: Screenshot['setEnabled'] = enabled =>
  invokeNative<Awaited<ReturnType<Screenshot['setEnabled']>>>('screenshot_settings_set', {
    enabled: Boolean(enabled)
  })

const openPermissionSettings: Screenshot['openPermissionSettings'] = kind =>
  invokeNative<void>('screenshot_open_permission', { kind })

const capture: Screenshot['capture'] = requestId =>
  invokeNative<Awaited<ReturnType<Screenshot['capture']>>>('screenshot_capture', { requestId })

const onStatus: Screenshot['onStatus'] = callback =>
  listenEvent<{ enabled: boolean; state: string }>(STATUS_EVENT, status => {
    if (status && typeof status === 'object' && typeof status.enabled === 'boolean') {
      callback(status as never)
    }
  })

const onRequest: Screenshot['onRequest'] = callback => {
  void invokeNative('screenshot_subscribe', { subscribed: true }).catch(() => undefined)

  const stop = listenEvent<string>(REQUEST_EVENT, requestId => {
    if (typeof requestId === 'string' && requestId) {
      callback(requestId)
    }
  })

  return () => {
    stop()
    void invokeNative('screenshot_subscribe', { subscribed: false }).catch(() => undefined)
  }
}

const api: Screenshot = {
  getSettings,
  setEnabled,
  openPermissionSettings,
  capture,
  onStatus,
  onRequest
}

export const screenshotBridge: Pick<Bridge, 'screenshot'> | Record<string, never> = IS_DESKTOP
  ? { screenshot: api }
  : {}
