/**
 * `hermesDesktop.petOverlay` — pop-out mascot window.
 *
 * Electron SoT: `pet-overlay-ipc.ts`. Rust: `pet_overlay.rs` (`sat-pet`).
 * State/control: `hermes://pet-overlay-*` events (Electron forwarded via main).
 */

import { IS_DESKTOP } from '@/lib/platform'
import type {
  PetOverlayBounds,
  PetOverlayControl,
  PetOverlayOpenRequest,
  PetOverlayStatePayload
} from '@/store/pet-overlay'

type Bridge = NonNullable<typeof window.hermesDesktop>
type PetOverlay = Bridge['petOverlay']

const STATE_EVENT = 'hermes://pet-overlay-state'
const CONTROL_EVENT = 'hermes://pet-overlay-control'

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

const open: PetOverlay['open'] = async request => {
  try {
    return await invokeNative<{ ok: boolean; bounds?: PetOverlayBounds }>('pet_overlay_open', {
      request: request ?? null
    })
  } catch {
    return { ok: false }
  }
}

const close: PetOverlay['close'] = async () => {
  try {
    return await invokeNative<{ ok: boolean }>('pet_overlay_close')
  } catch {
    return { ok: false }
  }
}

const setBounds: PetOverlay['setBounds'] = bounds => {
  void invokeNative('pet_overlay_set_bounds', { bounds }).catch(() => undefined)
}

const setIgnoreMouse: PetOverlay['setIgnoreMouse'] = ignore => {
  void invokeNative('pet_overlay_set_ignore_mouse', { ignore: Boolean(ignore) }).catch(() => undefined)
}

const setFocusable: PetOverlay['setFocusable'] = focusable => {
  void invokeNative('pet_overlay_set_focusable', { focusable: Boolean(focusable) }).catch(
    () => undefined
  )
}

const pushState: PetOverlay['pushState'] = payload => {
  void invokeNative('pet_overlay_push_state', { payload }).catch(() => undefined)
}

const control: PetOverlay['control'] = payload => {
  void invokeNative('pet_overlay_control', { payload }).catch(() => undefined)
}

const onState: PetOverlay['onState'] = callback =>
  listenEvent<PetOverlayStatePayload>(STATE_EVENT, payload => {
    if (payload && typeof payload === 'object') {
      callback(payload)
    }
  })

const onControl: PetOverlay['onControl'] = callback =>
  listenEvent<PetOverlayControl>(CONTROL_EVENT, payload => {
    if (payload && typeof payload === 'object' && 'type' in payload) {
      callback(payload)
    }
  })

export const petOverlayBridge: Pick<Bridge, 'petOverlay'> | Record<string, never> = IS_DESKTOP
  ? {
      petOverlay: {
        open,
        close,
        setBounds,
        setIgnoreMouse,
        setFocusable,
        pushState,
        control,
        onState,
        onControl
      }
    }
  : {}

// Keep the open-request type exported for tests that construct one.
export type { PetOverlayOpenRequest }
