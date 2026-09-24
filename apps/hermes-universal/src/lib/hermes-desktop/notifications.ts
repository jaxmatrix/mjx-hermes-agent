/**
 * `notify`, over `tauri-plugin-notification`.
 *
 * Desktop's dispatcher (`store/native-notifications.ts`) does the gating — prefs,
 * foreground, throttle — and hands over Electron's payload. This delivers it and
 * answers Electron's boolean: whether the OS took it (the Settings test button
 * reads that to flag a denied permission).
 *
 * WHAT COMES BACK is a platform fact (`lib/native-notification-capabilities`).
 * On a desktop OS the plugin has no click hook and no buttons, so a
 * notification is fire-and-forget and `onNotificationActivate`,
 * `onNotificationAction` and `onFocusSession` stay ABSENT — a subscription that
 * can never fire would be a fake, and their one caller optional-chains all
 * three. On a phone a tap arrives through the listener `boot.ts` arms
 * (`store/plugin-notify-handlers.ts`), which looks a `notifyId` up in ITS
 * registry. Desktop keeps the plugin's closures in its own, so a delivered
 * notification is registered there as a forward into desktop's: one tap, one
 * handler, and the activation target is still re-resolved through the deep-link
 * guard on the way back.
 *
 * Buttons go out for plugin notifications only, as before the resync. An
 * approval's Approve/Deny ride `onNotificationAction`, which no phone root
 * listens to.
 */

import { nativeNotificationCapabilities } from '@/lib/native-notification-capabilities'

type Bridge = NonNullable<typeof window.hermesDesktop>
type Payload = Parameters<Bridge['notify']>[0]
type Action = NonNullable<Payload['actions']>[number]

/** Android and iOS cap the buttons on one notification. */
const MAX_ACTIONS = 3
/** A registered category lives for the process, so the set is bounded. */
const MAX_ACTION_TYPES = 16

const actionTypes = new Set<string>()

/** One answer per window: the prompt is shown at most once. */
let permission: null | Promise<boolean> = null

function permitted(): Promise<boolean> {
  permission ??= import('@tauri-apps/plugin-notification')
    .then(async plugin => (await plugin.isPermissionGranted()) || (await plugin.requestPermission()) === 'granted')
    .catch(() => false)

  return permission
}

/** Same buttons, same category, one registration. djb2 — a hash, not a secret. */
function actionTypeId(actions: Action[]): string {
  const source = actions.map(action => `${action.id}\u0000${action.text}`).join('\u0001')
  let hash = 5381

  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0
  }

  return `hermes.plugin.${(hash >>> 0).toString(36)}`
}

/** The category's id, or null when the platform refused — the notification
 *  still goes out, without buttons. */
async function ensureActionType(actions: Action[]): Promise<null | string> {
  const id = actionTypeId(actions)

  if (actionTypes.has(id)) {
    return id
  }

  try {
    const { registerActionTypes } = await import('@tauri-apps/plugin-notification')

    await registerActionTypes([{ actions: actions.map(action => ({ id: action.id, title: action.text })), id }])
  } catch {
    return null
  }

  while (actionTypes.size >= MAX_ACTION_TYPES) {
    const oldest = actionTypes.values().next().value

    if (oldest === undefined) {
      break
    }

    actionTypes.delete(oldest)
  }

  actionTypes.add(id)

  return id
}

/** Forward a tap on `notifyId` into desktop's closure registry. Only after the
 *  notification went out: one that never fired can never be tapped. */
async function forwardTaps(notifyId: string, actions: Action[]): Promise<void> {
  // Dynamic: both stores are outside the install graph.
  const [handlers, desktop] = await Promise.all([
    import('@/store/plugin-notify-handlers'),
    import('@/store/native-notifications')
  ])

  handlers.registerNotifyHandlers(notifyId, {
    actions: actions.map(action => ({
      id: action.id,
      onAction: () => {
        desktop.invokePluginNotifyAction(notifyId, action.id)
        desktop.clearPluginNotifyHandlers(notifyId)
      }
    })),
    onActivate: () => {
      desktop.invokePluginNotifyActivate(notifyId)
      desktop.clearPluginNotifyHandlers(notifyId)
    }
  })
}

const notify: Bridge['notify'] = async payload => {
  if (!(await permitted())) {
    return false
  }

  const caps = nativeNotificationCapabilities()
  const actions = caps.actions && payload?.kind === 'plugin' ? (payload.actions ?? []).slice(0, MAX_ACTIONS) : []
  const typeId = actions.length > 0 ? await ensureActionType(actions) : null
  const sent = typeId ? actions : []
  const notifyId = caps.activation ? payload?.notifyId : undefined
  const activate = caps.activation ? payload?.activate : undefined

  const actionActivate = Object.fromEntries(
    sent.flatMap(action => (action.activate ? [[action.id, action.activate]] : []))
  )

  const icon = typeof payload?.icon === 'string' && payload.icon.trim() ? payload.icon.trim() : undefined

  const extra = {
    ...(notifyId && { notifyId }),
    ...(activate && { activate }),
    ...(Object.keys(actionActivate).length > 0 && { actionActivate })
  }

  try {
    const { sendNotification } = await import('@tauri-apps/plugin-notification')

    sendNotification({
      body: payload?.body || '',
      silent: Boolean(payload?.silent),
      title: payload?.title || 'Hermes',
      ...(icon && { icon }),
      ...(typeId && { actionTypeId: typeId }),
      ...(Object.keys(extra).length > 0 && { extra })
    })
  } catch {
    return false
  }

  if (notifyId) {
    await forwardTaps(notifyId, sent).catch(() => undefined)
  }

  return true
}

export const notificationsBridge: Pick<Bridge, 'notify'> = { notify }

/** Test seam: forget the permission answer and the registered categories. */
export function __resetNotifications(): void {
  permission = null
  actionTypes.clear()
}
