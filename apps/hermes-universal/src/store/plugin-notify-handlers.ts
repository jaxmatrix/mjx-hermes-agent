import { onAction, onNotificationReceived, type Options } from '@tauri-apps/plugin-notification'

import { resolveHermesOpenPath } from '@/lib/hermes-open-target'
import { nativeNotificationCapabilities } from '@/lib/native-notification-capabilities'

import { navigateDeepLinkPath } from './deep-link'

/**
 * The in-process half of an actionable OS notification.
 *
 * ONLY an id crosses the IPC boundary. A plugin's `onActivate` / `onAction`
 * closures cannot be serialised into a notification and cannot survive the
 * process anyway, so they are held here under a `notifyId` that rides in the
 * notification's `extra` and is looked up when the OS hands the tap back.
 *
 * Two rules this module exists to keep, both from desktop's `aae96913df`:
 *
 *  1. HANDLERS ARE REGISTERED ONLY WHEN THE NOTIFICATION ACTUALLY FIRED. A
 *     throttled, prefs-disabled or foreground-suppressed notification can never
 *     be clicked, so holding its closures would leak them for the window's life.
 *     `store/native-notifications.ts` registers after its guards, not before.
 *  2. THE ACTIVATION TARGET IS RE-RESOLVED AT THE BOUNDARY. What comes back
 *     through the OS is not necessarily what we put in, so the pre-IPC
 *     validation is not trusted and the path goes through the same guard a deep
 *     link does.
 */

export interface PluginNotifyAction {
  id: string
  onAction?: () => void
}

export interface PluginNotifyHandlers {
  onActivate?: () => void
  actions?: PluginNotifyAction[]
}

const handlers = new Map<string, PluginNotifyHandlers>()

/** Bounded so a plugin that notifies in a loop cannot grow the map without end
 *  — every entry is a closure. Oldest out; the newest notification is the one
 *  the user is most likely to still have on screen. */
const MAX_PENDING_HANDLERS = 64

export function registerNotifyHandlers(notifyId: string, entry: PluginNotifyHandlers): void {
  while (handlers.size >= MAX_PENDING_HANDLERS) {
    const oldest = handlers.keys().next().value

    if (oldest === undefined) {
      break
    }

    handlers.delete(oldest)
  }

  handlers.set(notifyId, entry)
}

export function clearPluginNotifyHandlers(notifyId: null | string | undefined): void {
  if (notifyId) {
    handlers.delete(notifyId)
  }
}

/** Run the body-tap closure. Unknown id = a notification from a previous run of
 *  the app, which is a no-op rather than an error. */
export function invokePluginNotifyActivate(notifyId: null | string | undefined): boolean {
  const entry = notifyId ? handlers.get(notifyId) : undefined

  if (!entry?.onActivate) {
    return false
  }

  entry.onActivate()

  return true
}

export function invokePluginNotifyAction(
  notifyId: null | string | undefined,
  actionId: null | string | undefined
): boolean {
  const entry = notifyId ? handlers.get(notifyId) : undefined
  const action = entry?.actions?.find(candidate => candidate.id === actionId)

  if (!action?.onAction) {
    return false
  }

  action.onAction()

  return true
}

/** The `extra` a dispatched notification carries. Everything in it came back
 *  through the OS, so nothing in it is trusted. */
interface NotifyExtra {
  notifyId?: unknown
  activate?: unknown
}

const asId = (value: unknown): null | string => (typeof value === 'string' && value ? value : null)

/**
 * Handle one tap. Exported for its own test — driving this through the real
 * plugin listeners would need a device.
 */
export function handleNotificationActivation(payload: Options & { actionId?: string }): void {
  const extra = (payload.extra ?? {}) as NotifyExtra
  const notifyId = asId(extra.notifyId)
  const actionId = asId(payload.actionId)

  if (actionId) {
    invokePluginNotifyAction(notifyId, actionId)
  } else {
    invokePluginNotifyActivate(notifyId)
  }

  // RE-RESOLVED here, not trusted from the payload: the pre-IPC validation
  // happened in a different process's memory. `navigateDeepLinkPath` then
  // applies the same route guard a `hermes://` link gets, so an activation can
  // never reach a path a deep link could not.
  const activate = asId(extra.activate)

  if (activate) {
    const path = resolveHermesOpenPath(activate)

    if (path) {
      navigateDeepLinkPath(path)
    }
  }

  // One activation per notification. A double-tap must not run the plugin's
  // handler twice.
  clearPluginNotifyHandlers(notifyId)
}

let installed = false

/**
 * Listen for taps. Idempotent, and a no-op where the platform has no activation
 * at all — on desktop the plugin registers no click hook, so subscribing there
 * would be a listener nothing can ever fire.
 */
export function installNotificationActivation(): void {
  if (installed || !nativeNotificationCapabilities().activation) {
    return
  }

  installed = true

  const listen = (subscribe: (cb: (payload: Options) => void) => Promise<unknown>) => {
    void subscribe(payload => handleNotificationActivation(payload)).catch(() => {
      // No Tauri host, or a plugin build without the mobile listener. Nothing
      // user-facing: a notification that cannot be activated still delivers.
    })
  }

  listen(onAction)
  listen(onNotificationReceived)
}

/** Test seam: drop every pending closure and re-arm the installer. */
export function __resetPluginNotifyHandlers(): void {
  handlers.clear()
  installed = false
}

/** Test seam: how many closures are being held. A throttled or suppressed
 *  notification must add none. */
export function __pendingNotifyHandlerCount(): number {
  return handlers.size
}
