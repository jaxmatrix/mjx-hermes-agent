import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-notification', () => ({
  onAction: vi.fn(async () => ({})),
  onNotificationReceived: vi.fn(async () => ({}))
}))

const navigateDeepLinkPath = vi.fn()

vi.mock('./deep-link', () => ({ navigateDeepLinkPath: (path: string) => navigateDeepLinkPath(path) }))

const caps = vi.hoisted(() => ({ actions: true, activation: true }))

vi.mock('@/lib/native-notification-capabilities', () => ({ nativeNotificationCapabilities: () => caps }))

import { onAction, onNotificationReceived } from '@tauri-apps/plugin-notification'

import {
  __pendingNotifyHandlerCount,
  __resetPluginNotifyHandlers,
  handleNotificationActivation,
  installNotificationActivation,
  registerNotifyHandlers
} from './plugin-notify-handlers'

beforeEach(() => {
  __resetPluginNotifyHandlers()
  navigateDeepLinkPath.mockClear()
  vi.mocked(onAction).mockClear()
  vi.mocked(onNotificationReceived).mockClear()
  caps.activation = true
})

const tap = (extra: Record<string, unknown>, actionId?: string) =>
  handleNotificationActivation({ extra, title: 'x', ...(actionId ? { actionId } : {}) })

describe('activation', () => {
  it('runs the body-tap closure', () => {
    const onActivate = vi.fn()
    registerNotifyHandlers('n1', { onActivate })

    tap({ notifyId: 'n1' })

    expect(onActivate).toHaveBeenCalledOnce()
  })

  it('routes an action id to ITS closure and to no other', () => {
    const approve = vi.fn()
    const reject = vi.fn()
    registerNotifyHandlers('n1', {
      actions: [
        { id: 'approve', onAction: approve },
        { id: 'reject', onAction: reject }
      ]
    })

    tap({ notifyId: 'n1' }, 'reject')

    expect(reject).toHaveBeenCalledOnce()
    expect(approve).not.toHaveBeenCalled()
  })

  it('does not run the body closure when a BUTTON was tapped', () => {
    const onActivate = vi.fn()
    const approve = vi.fn()
    registerNotifyHandlers('n1', { actions: [{ id: 'approve', onAction: approve }], onActivate })

    tap({ notifyId: 'n1' }, 'approve')

    expect(approve).toHaveBeenCalledOnce()
    expect(onActivate).not.toHaveBeenCalled()
  })

  // A notification outlives the process that sent it, so an id from a previous
  // run of the app is a routine arrival, not an error.
  it.each([
    ['an unknown id', { notifyId: 'never-registered' }],
    ['no id at all', {}],
    ['a non-string id', { notifyId: 42 }]
  ])('is a no-op for %s', (_label, extra) => {
    expect(() => tap(extra)).not.toThrow()
  })

  it('clears the handlers after ONE activation, so a double tap does nothing twice', () => {
    const onActivate = vi.fn()
    registerNotifyHandlers('n1', { onActivate })

    tap({ notifyId: 'n1' })
    tap({ notifyId: 'n1' })

    expect(onActivate).toHaveBeenCalledOnce()
    expect(__pendingNotifyHandlerCount()).toBe(0)
  })
})

describe('the activate target', () => {
  it('navigates through the deep-link guard, not with a bare navigate', () => {
    tap({ activate: '/skills?tab=mcp' })

    expect(navigateDeepLinkPath).toHaveBeenCalledWith('/skills?tab=mcp')
  })

  // aae96913df, and the reason the resolve happens twice: what comes back
  // through the OS is not necessarily what we put in, so the pre-IPC validation
  // is not trusted.
  it.each([
    ['a traversal', '/a/..%2Fb'],
    ['a scheme', '/javascript:alert(1)'],
    ['a protocol-relative url', '//evil.example/x'],
    ['a non-path', 'not-a-path'],
    ['a non-string', 7]
  ])('navigates nowhere for %s', (_label, activate) => {
    tap({ activate })

    expect(navigateDeepLinkPath).not.toHaveBeenCalled()
  })

  it('still navigates when the closure is gone — the target is independent', () => {
    tap({ activate: '/skills', notifyId: 'expired' })

    expect(navigateDeepLinkPath).toHaveBeenCalledWith('/skills')
  })
})

describe('installNotificationActivation', () => {
  it('subscribes to both taps once, however often it is called', () => {
    installNotificationActivation()
    installNotificationActivation()

    expect(onAction).toHaveBeenCalledOnce()
    expect(onNotificationReceived).toHaveBeenCalledOnce()
  })

  // The desktop notification plugin registers no click hook at all, so a
  // listener there is one nothing can ever fire.
  it('subscribes to nothing where the platform has no activation', () => {
    caps.activation = false
    installNotificationActivation()

    expect(onAction).not.toHaveBeenCalled()
    expect(onNotificationReceived).not.toHaveBeenCalled()
  })
})
