import { isPermissionGranted, registerActionTypes, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

import { type HermesOpenTarget, resolveHermesOpenPath } from '@/lib/hermes-open-target'
import { nativeNotificationCapabilities } from '@/lib/native-notification-capabilities'
import { Codecs, persistentAtom } from '@/lib/persisted'

import { registerNotifyHandlers } from './plugin-notify-handlers'

// Native OS notifications (tauri-plugin-notification), separate from the in-app
// toast feed in notifications.ts. Adapted from apps/desktop/src/store/
// native-notifications.ts: the desktop `window.hermesDesktop.notify` bridge is
// swapped for the Tauri plugin, and the multi-session gating is simplified —
// mobile has a single active conversation, so "fire when the app is
// backgrounded" is the whole rule. Per-kind toggles + throttle are kept.

export type NativeNotificationKind =
  | 'approval'
  | 'backgroundDone'
  | 'credits'
  | 'input'
  | 'plugin'
  | 'turnDone'
  | 'turnError'

export const NATIVE_NOTIFICATION_KINDS: readonly NativeNotificationKind[] = [
  'approval',
  'input',
  'turnDone',
  'turnError',
  'backgroundDone',
  'credits',
  'plugin'
]

export interface NativeNotificationPrefs {
  enabled: boolean
  kinds: Record<NativeNotificationKind, boolean>
}

const DEFAULT_PREFS: NativeNotificationPrefs = {
  enabled: true,
  kinds: {
    approval: true,
    backgroundDone: true,
    credits: true,
    input: true,
    plugin: true,
    turnDone: true,
    turnError: true
  }
}

// A stored blob predates every kind added after it was written (and localStorage
// is untrusted anyway), so merge onto the defaults rather than trusting the
// parsed shape: without this a newly added kind reads back `undefined` and is
// silently off for everyone who has ever touched these prefs. Mirrors desktop's
// `readPrefs`.
function sanitizePrefs(value: unknown): NativeNotificationPrefs {
  const parsed = (value ?? {}) as Partial<NativeNotificationPrefs>
  const kinds = { ...DEFAULT_PREFS.kinds }

  for (const kind of NATIVE_NOTIFICATION_KINDS) {
    const stored = parsed.kinds?.[kind]

    if (typeof stored === 'boolean') {
      kinds[kind] = stored
    }
  }

  return { enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_PREFS.enabled, kinds }
}

export const $nativeNotifyPrefs = persistentAtom<NativeNotificationPrefs>(
  'hermes.native-notifications',
  DEFAULT_PREFS,
  Codecs.json<NativeNotificationPrefs>(sanitizePrefs)
)

export function setNativeNotifyEnabled(enabled: boolean) {
  $nativeNotifyPrefs.set({ ...$nativeNotifyPrefs.get(), enabled })
}

export function setNativeNotifyKind(kind: NativeNotificationKind, on: boolean) {
  const prev = $nativeNotifyPrefs.get()
  $nativeNotifyPrefs.set({ ...prev, kinds: { ...prev.kinds, [kind]: on } })
}

// De-dupe replayed events for the same kind+session. Self-evicting: entries
// older than the window are pruned on every dispatch, so the map can't grow.
const THROTTLE_MS = 1000
const lastFiredAt = new Map<string, number>()

function throttled(key: string, now: number): boolean {
  for (const [k, at] of lastFiredAt) {
    if (now - at >= THROTTLE_MS) {
      lastFiredAt.delete(k)
    }
  }

  if (lastFiredAt.has(key)) {
    return true
  }

  lastFiredAt.set(key, now)

  return false
}

// "Backgrounded" = the app isn't on screen. On the Android WebView `document.hidden`
// flips when the app is sent to the background; `hasFocus` covers the rest.
function isBackgrounded(): boolean {
  if (typeof document === 'undefined') {
    return false
  }

  if (document.hidden) {
    return true
  }

  return typeof document.hasFocus === 'function' && !document.hasFocus()
}

// Cache the granted state so we only prompt once per session.
let permissionGranted: boolean | null = null

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted !== null) {
    return permissionGranted
  }

  try {
    let granted = await isPermissionGranted()

    if (!granted) {
      granted = (await requestPermission()) === 'granted'
    }

    permissionGranted = granted

    return granted
  } catch {
    // No Tauri host (web dev) or the plugin is unavailable.
    permissionGranted = false

    return false
  }
}

export interface NativeNotificationInput {
  kind: NativeNotificationKind
  title: string
  body?: string
  sessionId?: null | string
  silent?: boolean
  /**
   * Extra throttle/dedupe discriminator for session-less notifications (e.g. the
   * plugin id), so unrelated emitters of the same kind don't collapse into one
   * another.
   */
  tag?: string
}

/** Why a notification did not go out. Named rather than reduced to a boolean:
 *  "you have them switched off" and "the OS refused permission" are different
 *  things for a caller to do something about (rule 9). */
export type NativeNotifyRefusal = 'foreground' | 'kind-off' | 'no-permission' | 'prefs-off' | 'send-failed' | 'throttled'

export interface NativeNotifyOutcome {
  /**
   * It reached the OS bridge. NOT "the user saw it": a Linux session with no
   * notification daemon accepts and discards, and nothing tells us. This is the
   * honest limit of what can be known from here.
   */
  delivered: boolean
  refusal?: NativeNotifyRefusal
  /** False whenever actions were asked for and the platform has none. */
  actionsDelivered: boolean
  /** Present only when closures were registered — i.e. only when it can be
   *  clicked at all. */
  notifyId?: string
}

/**
 * Everything that must be TRUE before the OS is asked, in order and with a
 * name for each refusal.
 *
 * Runs exactly once per dispatch: `throttled` records the fire, so calling this
 * twice would consume the throttle slot.
 */
function refuseNativeNotification(input: NativeNotificationInput): NativeNotifyRefusal | null {
  const prefs = $nativeNotifyPrefs.get()

  if (!prefs.enabled) {
    return 'prefs-off'
  }

  if (!prefs.kinds[input.kind]) {
    return 'kind-off'
  }

  if (!isBackgrounded()) {
    return 'foreground'
  }

  if (throttled(`${input.kind}:${input.sessionId ?? input.tag ?? ''}`, Date.now())) {
    return 'throttled'
  }

  return null
}

/** Fields the plugin door adds on top of the app's own notifications. */
interface NativeNotifyExtras {
  actionTypeId?: string
  extra?: Record<string, unknown>
  icon?: string
}

async function deliverNativeNotification(
  input: NativeNotificationInput,
  extras: NativeNotifyExtras = {}
): Promise<NativeNotifyOutcome> {
  const refusal = refuseNativeNotification(input)

  if (refusal) {
    return { actionsDelivered: false, delivered: false, refusal }
  }

  if (!(await ensurePermission())) {
    return { actionsDelivered: false, delivered: false, refusal: 'no-permission' }
  }

  try {
    sendNotification({ ...extras, body: input.body, silent: input.silent, title: input.title })

    return { actionsDelivered: false, delivered: true }
  } catch {
    // Best-effort: a delivery failure shouldn't surface to the user.
    return { actionsDelivered: false, delivered: false, refusal: 'send-failed' }
  }
}

/**
 * The app's own notifications. Fire-and-forget by design — every caller in
 * `store/event-router.ts` is reacting to a stream event and has nothing to do
 * with the answer. The plugin door below awaits the same path.
 */
export function dispatchNativeNotification(input: NativeNotificationInput): void {
  void deliverNativeNotification(input)
}

// -- the plugin door (`ctx.os.notify`) ----------------------------------------

export interface PluginNotificationAction {
  id: string
  label: string
  /** Where a tap on this button lands, as an in-app target. */
  activate?: HermesOpenTarget
  /** In-process callback. ONLY `id` crosses the IPC boundary — this closure is
   *  held here and looked up when the OS hands the tap back. */
  onAction?: () => void
}

export interface PluginNativeNotificationInput {
  title: string
  body?: string
  silent?: boolean
  /**
   * ANDROID: a drawable RESOURCE NAME (`ic_stat_x`) from the app's
   * `res/drawable`, not a filesystem path — desktop's Electron contract took an
   * absolute path, and accepting one here would hand the OS a plugin-controlled
   * file reference. iOS ignores it.
   */
  icon?: string
  /** Where a tap on the notification body lands. */
  activate?: HermesOpenTarget
  onActivate?: () => void
  /** At most `MAX_NOTIFICATION_ACTIONS`, and dropped entirely where the platform
   *  has no action support — which is every desktop OS. */
  actions?: PluginNotificationAction[]
}

/** Android shows 3 action buttons, iOS 4. Take the floor so a plugin written
 *  against one platform is not silently truncated on the other. */
export const MAX_NOTIFICATION_ACTIONS = 3

/** Android and iOS keep a registered notification CATEGORY for the process's
 *  life, so an unbounded set of them is a slow leak in the OS rather than in us. */
export const MAX_ACTION_TYPES = 16

/** Registered action-type ids, oldest first (a plain insertion-ordered Map is
 *  the LRU — re-registering the same list is a no-op, so recency does not need
 *  tracking beyond "have we sent this one"). */
const actionTypes = new Set<string>()

/** Stable id for a list of actions: same buttons, same category, one
 *  registration. djb2 over the id/label pairs — a hash, not a secret. */
function actionTypeId(actions: PluginNotificationAction[]): string {
  const source = actions.map(action => `${action.id}\u0000${action.label}`).join('\u0001')
  let hash = 5381

  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0
  }

  return `hermes.plugin.${(hash >>> 0).toString(36)}`
}

/** Register the category once, and answer with its id — or null when the
 *  platform refused, which the caller reports rather than pretending. */
async function ensureActionType(actions: PluginNotificationAction[]): Promise<null | string> {
  const id = actionTypeId(actions)

  if (actionTypes.has(id)) {
    return id
  }

  try {
    await registerActionTypes([{ actions: actions.map(a => ({ id: a.id, title: a.label })), id }])
  } catch {
    // An older mobile plugin build with no `register_action_types`. The
    // notification still goes out — without buttons.
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

/**
 * Native OS notification on behalf of a plugin.
 *
 * One "Plugin notifications" preference gates every plugin; the plugin id keys
 * throttling so two plugins cannot collapse each other's notifications. Fires
 * only while the user is away from Hermes — the in-app toast (`host.notify`)
 * covers the foreground case.
 *
 * ORDER MATTERS at step 7 below: closures are registered only AFTER the
 * notification actually went out. A throttled or suppressed notification can
 * never be clicked, so holding its closures would leak them for the window's
 * lifetime (desktop's `aae96913df`).
 */
export async function dispatchPluginNativeNotification(
  pluginId: string,
  input: PluginNativeNotificationInput
): Promise<NativeNotifyOutcome> {
  const caps = nativeNotificationCapabilities()
  const requested = input.actions ?? []
  const actions = caps.actions ? requested.slice(0, MAX_NOTIFICATION_ACTIONS) : []

  // Resolved BEFORE the boundary so a bad target never leaves the app — and
  // re-resolved on the way back, because what returns is not necessarily this.
  const activate = resolveHermesOpenPath(input.activate) ?? undefined

  const needsHandlers = Boolean(input.onActivate) || actions.some(action => action.onAction)

  const notifyId =
    needsHandlers && caps.activation
      ? `${pluginId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
      : undefined

  const registeredType = actions.length > 0 ? await ensureActionType(actions) : null

  const outcome = await deliverNativeNotification(
    { body: input.body, kind: 'plugin', silent: input.silent, tag: pluginId, title: input.title },
    {
      ...(registeredType ? { actionTypeId: registeredType } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(notifyId || activate ? { extra: { ...(notifyId ? { notifyId } : {}), ...(activate ? { activate } : {}) } } : {})
    }
  )

  if (outcome.delivered && notifyId) {
    registerNotifyHandlers(notifyId, {
      actions: actions.map(action => ({ id: action.id, onAction: action.onAction })),
      onActivate: input.onActivate
    })
  }

  return {
    ...outcome,
    // False whenever buttons were asked for and did not go out — either the
    // platform has none, or registering the category failed. A plugin that
    // checks this can fall back to an in-app toast.
    actionsDelivered: outcome.delivered && requested.length > 0 && Boolean(registeredType),
    ...(outcome.delivered && notifyId ? { notifyId } : {})
  }
}

/** Test seam: forget the registered categories, so an LRU case starts from a
 *  known set rather than from whatever earlier cases happened to register. */
export function __resetNotificationActionTypes(): void {
  actionTypes.clear()
}

// Settings "send test" — bypasses the background/throttle gating. Returns whether
// the OS accepted it so the panel can flag a silent permission failure.
export async function sendTestNativeNotification(title: string, body: string): Promise<boolean> {
  if (!(await ensurePermission())) {
    return false
  }

  try {
    sendNotification({ title, body })

    return true
  } catch {
    return false
  }
}
