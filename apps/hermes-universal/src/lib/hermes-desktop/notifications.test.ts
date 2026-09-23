import { beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({
  granted: true,
  registered: [] as unknown[],
  request: 'granted' as string,
  sent: [] as Record<string, unknown>[]
}))

const caps = vi.hoisted(() => ({ actions: false, activation: false }))
const desktop = vi.hoisted(() => ({ action: vi.fn(), activate: vi.fn(), clear: vi.fn() }))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => plugin.granted,
  onAction: vi.fn(async () => ({})),
  onNotificationReceived: vi.fn(async () => ({})),
  registerActionTypes: async (types: unknown) => void plugin.registered.push(types),
  requestPermission: async () => plugin.request,
  sendNotification: (options: Record<string, unknown>) => void plugin.sent.push(options)
}))
vi.mock('@/lib/native-notification-capabilities', () => ({ nativeNotificationCapabilities: () => caps }))
const navigateDeepLinkPath = vi.hoisted(() => vi.fn())

vi.mock('@/store/deep-link', () => ({ navigateDeepLinkPath }))
vi.mock('@/store/native-notifications', () => ({
  clearPluginNotifyHandlers: desktop.clear,
  invokePluginNotifyAction: desktop.action,
  invokePluginNotifyActivate: desktop.activate
}))

import {
  __pendingNotifyHandlerCount,
  __resetPluginNotifyHandlers,
  handleNotificationActivation
} from '@/store/plugin-notify-handlers'

import { __resetNotifications, notificationsBridge } from './notifications'

const PLUGIN = {
  actions: [
    { activate: '/cron', id: 'open', text: 'Open' },
    { id: 'later', text: 'Later' }
  ],
  activate: '/settings',
  body: 'b',
  kind: 'plugin',
  notifyId: 'p:1',
  title: 't'
}

beforeEach(() => {
  plugin.granted = true
  plugin.request = 'granted'
  plugin.registered = []
  plugin.sent = []
  caps.actions = false
  caps.activation = false
  Object.values(desktop).forEach(mock => mock.mockClear())
  navigateDeepLinkPath.mockClear()
  __resetNotifications()
  __resetPluginNotifyHandlers()
})

describe('hermesDesktop.notify', () => {
  it('delivers Electron’s payload and answers true', async () => {
    await expect(notificationsBridge.notify({ body: 'done', kind: 'turnDone', silent: true })).resolves.toBe(true)

    expect(plugin.sent).toEqual([{ body: 'done', silent: true, title: 'Hermes' }])
  })

  it('answers false when the OS says no, asking once', async () => {
    plugin.granted = false
    plugin.request = 'denied'

    await expect(notificationsBridge.notify({ title: 't' })).resolves.toBe(false)
    await expect(notificationsBridge.notify({ title: 't' })).resolves.toBe(false)
    expect(plugin.sent).toEqual([])
  })

  it('is fire-and-forget on a desktop OS: no buttons, no tap state, nothing held', async () => {
    await notificationsBridge.notify(PLUGIN)

    expect(plugin.sent).toEqual([{ body: 'b', silent: false, title: 't' }])
    expect(plugin.registered).toEqual([])
    expect(__pendingNotifyHandlerCount()).toBe(0)
  })

  it('on a phone, a tap reaches desktop’s closure exactly once', async () => {
    caps.actions = true
    caps.activation = true

    await notificationsBridge.notify(PLUGIN)

    expect(plugin.sent[0]).toMatchObject({
      actionTypeId: expect.stringMatching(/^hermes\.plugin\./),
      extra: { actionActivate: { open: '/cron' }, activate: '/settings', notifyId: 'p:1' }
    })

    handleNotificationActivation({ extra: plugin.sent[0]!.extra as Record<string, unknown>, title: 't' })
    handleNotificationActivation({ extra: plugin.sent[0]!.extra as Record<string, unknown>, title: 't' })

    expect(desktop.activate).toHaveBeenCalledExactlyOnceWith('p:1')
    expect(desktop.action).not.toHaveBeenCalled()
    expect(desktop.clear).toHaveBeenCalledWith('p:1')
  })

  it('on a phone, a button reaches ITS closure and goes to its own target', async () => {
    caps.actions = true
    caps.activation = true

    await notificationsBridge.notify(PLUGIN)
    handleNotificationActivation({
      actionId: 'open',
      extra: plugin.sent[0]!.extra as Record<string, unknown>,
      title: 't'
    })

    expect(desktop.action).toHaveBeenCalledExactlyOnceWith('p:1', 'open')
    expect(desktop.activate).not.toHaveBeenCalled()
    expect(navigateDeepLinkPath).toHaveBeenCalledExactlyOnceWith('/cron')
  })

  it('sends an approval without buttons: no phone root listens for their press', async () => {
    caps.actions = true
    caps.activation = true

    await notificationsBridge.notify({
      actions: [{ id: 'approve', text: 'Approve' }],
      kind: 'approval',
      sessionId: 's1'
    })

    expect(plugin.registered).toEqual([])
    expect(plugin.sent[0]).not.toHaveProperty('actionTypeId')
  })
})
