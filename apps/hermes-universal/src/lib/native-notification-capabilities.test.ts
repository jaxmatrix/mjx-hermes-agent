import { describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ IS_NATIVE_MOBILE: false }))

vi.mock('./platform', () => platform)

import { nativeNotificationCapabilities } from './native-notification-capabilities'

describe('nativeNotificationCapabilities', () => {
  // The INVERSION of the usual matrix, and the reason this is asked rather than
  // assumed: `tauri-plugin-notification` registers `register_action_types` only
  // in its mobile half, and its desktop half has no click hook at all. So a
  // desktop notification has no buttons AND no body-tap — the opposite of where
  // richer OS integration normally lives.
  it('reports no actions and no activation off a native phone', () => {
    platform.IS_NATIVE_MOBILE = false

    expect(nativeNotificationCapabilities()).toEqual({ actions: false, activation: false })
  })

  it('reports both on Android and iOS', () => {
    platform.IS_NATIVE_MOBILE = true

    expect(nativeNotificationCapabilities()).toEqual({ actions: true, activation: true })
  })

  // A FUNCTION, not a frozen const: platform detection can resolve late on iOS
  // (the webview boot race, MJX-203), and a value captured at module init would
  // outlive the answer.
  it('re-reads the platform on every call rather than freezing at import', () => {
    platform.IS_NATIVE_MOBILE = false
    expect(nativeNotificationCapabilities().actions).toBe(false)

    platform.IS_NATIVE_MOBILE = true
    expect(nativeNotificationCapabilities().actions).toBe(true)
  })
})
