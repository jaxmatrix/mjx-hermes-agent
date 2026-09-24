/**
 * `hermesDesktop.hud` — chrome-free floating chat satellite.
 *
 * Electron SoT: `hud-ipc.ts` + `hud-windowing.ts`. Rust: `hud.rs` (`sat-hud`)
 * plus `open_satellite_window` / `hide_satellite_window`. Frost rides
 * `appearance_set_glass` on the HUD webview itself.
 */

import { IS_DESKTOP, PLATFORM } from '@/lib/platform'

type Bridge = NonNullable<typeof window.hermesDesktop>
type Hud = NonNullable<Bridge['hud']>

const CHANGED_EVENT = 'hermes://hud-changed'
const GOTO_EVENT = 'hermes://hud-goto'
const SATELLITE_CLOSED = 'hermes://satellite-window-closed'

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

/** Electron `hudWindowingView` — mirrored from Rust `hud_windowing` when we can
 *  ask, with a sync fallback so `nativeDrag` / `windowing` exist at install time. */
function syncWindowing(): NonNullable<Hud['windowing']> {
  switch (PLATFORM) {
    case 'macos':

    case 'windows':
      return {
        clientPlacement: true,
        controlDrag: false,
        nativeDrag: false,
        solid: false,
        workspaceTransfer: false
      }

    case 'linux':
      // Best-effort without Rust. Prefer the Wayland-shaped profile (click-through
      // + native-drag); Rust overwrites via `hud_windowing` once the invoke lands.
      return {
        clientPlacement: false,
        controlDrag: false,
        nativeDrag: true,
        solid: false,
        workspaceTransfer: false
      }

    default:
      return {
        clientPlacement: false,
        controlDrag: false,
        nativeDrag: false,
        solid: true,
        workspaceTransfer: false
      }
  }
}

const windowing: NonNullable<Hud['windowing']> = syncWindowing()

const open: Hud['open'] = async request => {
  try {
    const [{ openSatelliteWindow, HUD_SURFACE, doesSatelliteWindowExist }, { sessionRoute }] =
      await Promise.all([import('@/store/windows'), import('@/app/routes')])

    const sessionId =
      typeof request?.sessionId === 'string' && request.sessionId.trim()
        ? request.sessionId.trim()
        : null

    const profile =
      typeof request?.profile === 'string' && request.profile.trim() ? request.profile.trim() : null

    const existed = await doesSatelliteWindowExist(HUD_SURFACE)
    const route = sessionId ? sessionRoute(sessionId) : undefined
    const label = await openSatelliteWindow(HUD_SURFACE, route, profile)

    if (!label) {
      return { ok: false }
    }

    if (sessionId) {
      await invokeNative('hud_set_session', { sessionId }).catch(() => undefined)

      if (existed) {
        await invokeNative('hud_emit_goto', { sessionId }).catch(() => undefined)
      }
    }

    await invokeNative('hud_broadcast_changed', { open: true }).catch(() => undefined)

    return { ok: true }
  } catch {
    return { ok: false }
  }
}

const close: Hud['close'] = async () => {
  try {
    const { closeSatelliteWindow, HUD_SURFACE } = await import('@/store/windows')

    await closeSatelliteWindow(HUD_SURFACE)
    await invokeNative('hud_broadcast_changed', { open: false }).catch(() => undefined)

    return { ok: true }
  } catch {
    return { ok: false }
  }
}

const setIgnoreMouse: Hud['setIgnoreMouse'] = ignore => {
  void invokeNative('hud_set_ignore_mouse', { ignore: Boolean(ignore) }).catch(() => undefined)
}

const beginMove: Hud['beginMove'] = () => {
  void invokeNative('hud_begin_move', {}).catch(() => undefined)
}

const endMove: Hud['endMove'] = () => {
  void invokeNative('hud_end_move', {}).catch(() => undefined)
}

const moveBy: Hud['moveBy'] = delta => {
  void invokeNative('hud_move_by', {
    delta: {
      x: 0,
      y: 0,
      width: Number(delta?.width) || 0,
      height: Number(delta?.height) || 0
    }
  }).catch(() => undefined)
}

const setWorkspaceTransfer: NonNullable<Hud['setWorkspaceTransfer']> = transferring => {
  void invokeNative('hud_set_workspace_transfer', {
    transferring: Boolean(transferring)
  }).catch(() => undefined)
}

const setBounds: Hud['setBounds'] = bounds => {
  void invokeNative('hud_set_bounds', {
    bounds: {
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Number(bounds.width) || 0,
      height: Number(bounds.height) || 0
    }
  }).catch(() => undefined)
}

const resetLayout: Hud['resetLayout'] = async () => {
  try {
    return await invokeNative<{ ok: boolean }>('hud_reset_layout')
  } catch {
    return { ok: false }
  }
}

const setFrost: Hud['setFrost'] = async showing => {
  try {
    const [{ $translucency }, { glassActive }] = await Promise.all([
      import('@/store/translucency'),
      import('@/lib/translucency-model')
    ])

    const state = $translucency.get()
    const active = Boolean(showing) && glassActive(state)

    await invokeNative('appearance_set_glass', {
      state: active
        ? {
            mode: 'glass',
            intensity: Math.round(state.intensity),
            fade: Math.round(state.fade),
            material: state.material
          }
        : {
            mode: 'clear',
            intensity: 0,
            fade: 0,
            material: 'under-window'
          }
    })

    return { ok: true }
  } catch {
    return { ok: false }
  }
}

const setSession: Hud['setSession'] = sessionId => {
  void invokeNative('hud_set_session', {
    sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null
  }).catch(() => undefined)
}

const onGoto: Hud['onGoto'] = callback =>
  listenEvent<string>(GOTO_EVENT, sessionId => {
    if (typeof sessionId === 'string' && sessionId) {
      callback(sessionId)
    }
  })

const onChanged: Hud['onChanged'] = callback => {
  let stopChanged: (() => void) | undefined
  let stopClosed: (() => void) | undefined
  let cancelled = false

  void import('@tauri-apps/api/event')
    .then(async ({ listen }) => {
      if (cancelled) {
        return
      }

      stopChanged = await listen<{ open: boolean; sessionId: null | string }>(
        CHANGED_EVENT,
        message => {
          const state = message.payload

          if (state && typeof state === 'object' && typeof state.open === 'boolean') {
            callback({ open: state.open, sessionId: state.sessionId ?? null })
          }
        }
      )

      if (cancelled) {
        stopChanged()

        return
      }

      // Native hide/destroy also announces via the satellite bus — keep the
      // titlebar toggle honest when the HUD is dismissed from its own side.
      stopClosed = await listen<string>(SATELLITE_CLOSED, message => {
        if (message.payload === 'sat-hud') {
          callback({ open: false, sessionId: null })
        }
      })

      if (cancelled) {
        stopClosed()
      }
    })
    .catch(() => undefined)

  return () => {
    cancelled = true
    stopChanged?.()
    stopClosed?.()
  }
}

const onCursor: Hud['onCursor'] = callback =>
  // Electron Linux cursor feed — no Tauri poll yet; subscribe stays quiet.
  listenEvent<{ x: number; y: number } | null>('hermes://hud-cursor', point => {
    callback(point)
  })

const onGameOverlay: Hud['onGameOverlay'] = callback =>
  listenEvent<{ active: boolean; app: string }>('hermes://hud-game-overlay', state => {
    if (state && typeof state === 'object') {
      callback(state)
    }
  })

const hudApi: NonNullable<Bridge['hud']> = {
  nativeDrag: windowing.nativeDrag === true,
  windowing,
  open,
  close,
  setIgnoreMouse,
  beginMove,
  endMove,
  moveBy,
  setWorkspaceTransfer,
  setBounds,
  resetLayout,
  setFrost,
  setSession,
  onGoto,
  onChanged,
  onCursor,
  onGameOverlay
}

void invokeNative<NonNullable<Hud['windowing']>>('hud_windowing')
  .then(view => {
    if (view && typeof view === 'object') {
      Object.assign(windowing, view)
      hudApi.nativeDrag = view.nativeDrag === true
    }
  })
  .catch(() => undefined)

export const hudBridge: Pick<Bridge, 'hud'> | Record<string, never> = IS_DESKTOP
  ? { hud: hudApi }
  : {}
