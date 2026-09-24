/**
 * Tauri satellite ⇄ main-window transport handoff (MJXHRM-371).
 *
 * Desktop's `handoff.ts` is React hooks over Electron IPC; universal keeps that
 * file verbatim and implements the Rust `SATELLITE_WINDOW_CLOSED_EVENT` path here.
 */

import { sessionRoute } from '@/app/routes'
import { requestComposerDraftSync } from '@/lib/composer-draft-bus'
import { IS_TAURI } from '@/lib/platform'
import { navigateTo } from '@/lib/route-nav'
import { reloadPersistedDrafts } from '@/store/composer'
import { notifyError } from '@/store/notifications'
import { openSession } from '@/store/session-lifecycle'
import {
  HUD_SURFACE,
  isSatelliteWindow,
  SATELLITE_WINDOW_CLOSED_EVENT,
  satelliteSurfaceFromLabel
} from '@/store/windows'

const HUD_SESSION_KEY = 'hermes:hud-session'
const HUD_SUMMONER_KEY = 'hermes:hud-summoner'

let listenInstalled = false
let unlisten: (() => void) | null = null

/** Test seam — drop listeners and in-memory claim state. */
export function resetHudHandoff(): void {
  unlisten?.()
  unlisten = null
  listenInstalled = false
  window.localStorage.removeItem(HUD_SESSION_KEY)
  window.localStorage.removeItem(HUD_SUMMONER_KEY)
}

/** Arm the return trip before the HUD window exists. Idempotent. */
export function installHudHandoff(): void {
  if (listenInstalled || !IS_TAURI || isSatelliteWindow()) {
    return
  }

  listenInstalled = true

  void import('@tauri-apps/api/event').then(({ listen }) =>
    listen<string>(SATELLITE_WINDOW_CLOSED_EVENT, event => {
      const surface = satelliteSurfaceFromLabel(event.payload ?? '')

      if (surface !== HUD_SURFACE) {
        return
      }

      void rehomeFromHud()
    }).then(off => {
      unlisten = off
    })
  )
}

/** The window that summoned the HUD owns the close — peers must not re-home. */
export function noteHudSummoned(): void {
  window.localStorage.setItem(HUD_SUMMONER_KEY, '1')
}

/** HUD side (or tests): record which stored session the HUD is showing. */
export function reportHudSession(storedSessionId: null | string): void {
  if (storedSessionId) {
    window.localStorage.setItem(HUD_SESSION_KEY, storedSessionId)
  } else {
    window.localStorage.removeItem(HUD_SESSION_KEY)
  }
}

async function rehomeFromHud(): Promise<void> {
  if (window.localStorage.getItem(HUD_SUMMONER_KEY) !== '1') {
    return
  }

  window.localStorage.removeItem(HUD_SUMMONER_KEY)

  const hudSession = window.localStorage.getItem(HUD_SESSION_KEY)
  window.localStorage.removeItem(HUD_SESSION_KEY)

  const { $activeStoredSessionId } = await import('@/store/session-lifecycle')
  const target = hudSession ?? $activeStoredSessionId.get()

  reloadPersistedDrafts()
  requestComposerDraftSync('reload')

  if (!target) {
    return
  }

  try {
    await openSession(target, { forceResume: true })

    const selected = $activeStoredSessionId.get()

    if (target !== selected) {
      navigateTo(sessionRoute(target))
    }
  } catch (err) {
    notifyError(err, 'Could not resume the conversation after HUD mode')
  }
}
