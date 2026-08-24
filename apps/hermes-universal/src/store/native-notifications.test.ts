import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  registerActionTypes: vi.fn(async () => {}),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn()
}))

// Action buttons and tap activation are MOBILE-ONLY (the desktop notification
// plugin registers neither), so the capability is driven explicitly here — both
// directions, so no assertion rides on the test environment's own platform.
const caps = vi.hoisted(() => ({ actions: true, activation: true }))

vi.mock('@/lib/native-notification-capabilities', () => ({ nativeNotificationCapabilities: () => caps }))

import { type Options, registerActionTypes, sendNotification } from '@tauri-apps/plugin-notification'

import { MAX_ACTION_TYPES, MAX_NOTIFICATION_ACTIONS } from './native-notifications'
import {
  $nativeNotifyPrefs,
  __resetNotificationActionTypes,
  dispatchNativeNotification,
  dispatchPluginNativeNotification,
  setNativeNotifyEnabled,
  setNativeNotifyKind
} from './native-notifications'
import { __pendingNotifyHandlerCount, __resetPluginNotifyHandlers } from './plugin-notify-handlers'

// `sendNotification` is overloaded (`string | Options`); every call here passes
// the object form, so read it back through one narrow helper rather than casting
// at each assertion.
const send = vi.mocked(sendNotification)
const sentAt = (index: number) => send.mock.calls[index]?.[0] as Options | undefined
const registerTypes = vi.mocked(registerActionTypes)
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

// isBackgrounded() = document.hidden || !hasFocus(). Drive it via hasFocus.
function setBackgrounded(bg: boolean) {
  document.hasFocus = () => !bg
}

describe('native-notifications dispatch', () => {
  beforeEach(() => {
    send.mockClear()
    localStorage.clear()
    $nativeNotifyPrefs.set({
      enabled: true,
      kinds: { approval: true, backgroundDone: true, credits: true, input: true, plugin: true, turnDone: true, turnError: true }
    })
  })
  afterEach(() => setBackgrounded(false))

  it('fires when the app is backgrounded', async () => {
    setBackgrounded(true)
    dispatchNativeNotification({ kind: 'turnDone', title: 'done', body: 'ready', sessionId: 's1' })
    await flush()
    expect(send).toHaveBeenCalledWith({ title: 'done', body: 'ready' })
  })

  it('does not fire while the app is foregrounded', async () => {
    setBackgrounded(false)
    dispatchNativeNotification({ kind: 'turnDone', title: 'done', sessionId: 's2' })
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('respects the global enabled toggle', async () => {
    setBackgrounded(true)
    setNativeNotifyEnabled(false)
    dispatchNativeNotification({ kind: 'turnError', title: 'boom', sessionId: 's3' })
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('respects a per-kind toggle', async () => {
    setBackgrounded(true)
    setNativeNotifyKind('approval', false)
    dispatchNativeNotification({ kind: 'approval', title: 'approve', sessionId: 's4' })
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('throttles a repeated kind+session inside the window', async () => {
    setBackgrounded(true)
    dispatchNativeNotification({ kind: 'turnDone', title: 'a', sessionId: 's5' })
    dispatchNativeNotification({ kind: 'turnDone', title: 'b', sessionId: 's5' })
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('the plugin notification door', () => {
  beforeEach(() => {
    send.mockClear()
    registerTypes.mockClear().mockResolvedValue(undefined)
    caps.actions = true
    caps.activation = true
    __resetPluginNotifyHandlers()
    localStorage.clear()
    $nativeNotifyPrefs.set({
      enabled: true,
      kinds: { approval: true, backgroundDone: true, credits: true, input: true, plugin: true, turnDone: true, turnError: true }
    })
  })
  afterEach(() => setBackgrounded(false))

  it('fires under the plugin kind while the app is backgrounded', async () => {
    setBackgrounded(true)
    dispatchPluginNativeNotification('kanban', { title: 'Board moved', body: 'to Done', silent: true })
    await flush()
    expect(send).toHaveBeenCalledWith({ title: 'Board moved', body: 'to Done', silent: true })
  })

  it('is gated by the plugin toggle alone, not by the other kinds', async () => {
    setBackgrounded(true)
    setNativeNotifyKind('plugin', false)
    dispatchPluginNativeNotification('kanban', { title: 'Board moved' })
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('defaults a kind the stored prefs predate rather than reading it back as off', async () => {
    // Written by a build that had no `plugin` kind: without the sanitizer merge
    // it decodes to `undefined`, which reads as "the user turned this off".
    localStorage.setItem(
      'hermes.native-notifications',
      JSON.stringify({
        enabled: true,
        kinds: { approval: false, backgroundDone: true, input: true, turnDone: true, turnError: true }
      })
    )
    vi.resetModules()

    const { $nativeNotifyPrefs: reloaded } = await import('./native-notifications')

    expect(reloaded.get().kinds.plugin).toBe(true)
    // The user's own choices still win.
    expect(reloaded.get().kinds.approval).toBe(false)
  })

  it('keys throttling by plugin id so two plugins cannot collapse each other', async () => {
    setBackgrounded(true)
    dispatchPluginNativeNotification('alpha', { title: 'from alpha' })
    dispatchPluginNativeNotification('beta', { title: 'from beta' })
    dispatchPluginNativeNotification('alpha', { title: 'alpha again' })
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('rich plugin notifications', () => {
  beforeEach(() => {
    send.mockClear()
    __resetNotificationActionTypes()
    registerTypes.mockClear().mockResolvedValue(undefined)
    caps.actions = true
    caps.activation = true
    __resetPluginNotifyHandlers()
    localStorage.clear()
    setBackgrounded(true)
    $nativeNotifyPrefs.set({
      enabled: true,
      kinds: { approval: true, backgroundDone: true, credits: true, input: true, plugin: true, turnDone: true, turnError: true }
    })
  })

  afterEach(() => setBackgrounded(false))

  // A FRESH plugin id per case. The throttle is module-level and self-evicts
  // only after its window, so reusing one id would make each test throttle the
  // next — a green suite that proves nothing.
  let seq = 0
  const nextId = () => `plugin-${++seq}`

  const notify = (input: Parameters<typeof dispatchPluginNativeNotification>[1], id = nextId()) =>
    dispatchPluginNativeNotification(id, input)

  it('forwards the icon and the RESOLVED activate target', async () => {
    const outcome = await notify({
      activate: { params: { tab: 'mcp' }, path: '/skills' },
      icon: 'ic_stat_kanban',
      title: 'Board moved'
    })

    expect(outcome.delivered).toBe(true)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: { activate: '/skills?tab=mcp' },
        icon: 'ic_stat_kanban',
        title: 'Board moved'
      })
    )
  })

  it('refuses to carry an unsafe activate target across the boundary', async () => {
    await notify({ activate: '/a/..%2Fb', title: 'Board moved' })

    // The `extra` is omitted entirely rather than shipped and hoped about.
    expect(sentAt(0)).not.toHaveProperty('extra')
  })

  it('registers one action type per distinct button list and reuses it', async () => {
    const actions = [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' }
    ]

    const first = await notify({ actions, title: 'one' })
    const second = await notify({ actions, title: 'two' })

    expect(first.actionsDelivered).toBe(true)
    expect(second.actionsDelivered).toBe(true)
    // Same buttons, one category — the OS keeps registered categories for the
    // process's life.
    expect(registerTypes).toHaveBeenCalledTimes(1)
    expect(sentAt(0)?.actionTypeId).toBe(sentAt(1)?.actionTypeId)
  })

  // Android and iOS keep a registered CATEGORY for the process's life, so an
  // unbounded set of them is a slow leak in the OS rather than in us.
  it('caps the registered action types, re-registering an evicted one', async () => {
    const list = (n: number) => [{ id: `a${n}`, label: `A${n}` }]

    for (let i = 0; i < MAX_ACTION_TYPES; i += 1) {
      await notify({ actions: list(i), title: `n${i}` })
    }

    expect(registerTypes).toHaveBeenCalledTimes(MAX_ACTION_TYPES)

    // Cached: the same buttons do not re-register.
    await notify({ actions: list(MAX_ACTION_TYPES - 1), title: 'again' })
    expect(registerTypes).toHaveBeenCalledTimes(MAX_ACTION_TYPES)

    // One past the cap evicts the OLDEST, so its list registers afresh.
    await notify({ actions: list(MAX_ACTION_TYPES), title: 'overflow' })
    await notify({ actions: list(0), title: 'evicted' })

    expect(registerTypes).toHaveBeenCalledTimes(MAX_ACTION_TYPES + 2)
  })

  it('caps the button list at what the narrower platform shows', async () => {
    await notify({
      actions: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, label: `A${i}` })),
      title: 'many'
    })

    expect(registerTypes.mock.calls[0]?.[0]?.[0]?.actions).toHaveLength(MAX_NOTIFICATION_ACTIONS)
  })

  it('drops the buttons where the platform has none, and SAYS so', async () => {
    caps.actions = false

    const outcome = await notify({ actions: [{ id: 'approve', label: 'Approve' }], title: 'desktop' })

    expect(registerTypes).not.toHaveBeenCalled()
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('actionTypeId')
    // Delivered — without buttons. A plugin that checks this falls back to a
    // toast instead of waiting for a tap that can never come.
    expect(outcome).toMatchObject({ actionsDelivered: false, delivered: true })
  })

  it('reports actionsDelivered:false when registering the category fails', async () => {
    registerTypes.mockRejectedValue(new Error('older plugin build'))

    const outcome = await notify({ actions: [{ id: 'approve', label: 'Approve' }], title: 'x' })

    expect(outcome).toMatchObject({ actionsDelivered: false, delivered: true })
    expect(sentAt(0)).not.toHaveProperty('actionTypeId')
  })

  it('holds the closures only once the notification has actually fired', async () => {
    const outcome = await notify({ onActivate: () => {}, title: 'fired' })

    expect(outcome.notifyId).toBeTypeOf('string')
    expect(__pendingNotifyHandlerCount()).toBe(1)
  })

  // aae96913df: registering FIRST leaked the closures for the window's lifetime
  // every time a notification was refused. It can never be clicked, so it must
  // never hold one.
  it.each([
    ['throttled', async (id: string) => void (await dispatchPluginNativeNotification(id, { title: 'first' }))],
    ['prefs-off', async () => setNativeNotifyEnabled(false)],
    ['kind-off', async () => setNativeNotifyKind('plugin', false)],
    ['foreground', async () => setBackgrounded(false)]
  ])('registers NO handlers for a %s notification', async (_label, arrange) => {
    const id = nextId()
    await arrange(id)

    const outcome = await notify({ onActivate: () => {}, title: 'refused' }, id)

    expect(outcome.delivered).toBe(false)
    expect(outcome.refusal).toBeTypeOf('string')
    expect(outcome.notifyId).toBeUndefined()
    expect(__pendingNotifyHandlerCount()).toBe(0)
  })

  it('mints no notifyId where the platform cannot deliver a tap', async () => {
    caps.activation = false

    const outcome = await notify({ onActivate: () => {}, title: 'desktop' })

    expect(outcome.delivered).toBe(true)
    expect(outcome.notifyId).toBeUndefined()
    expect(__pendingNotifyHandlerCount()).toBe(0)
  })
})
