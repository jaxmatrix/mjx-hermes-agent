import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn()
}))

import { sendNotification } from '@tauri-apps/plugin-notification'

import {
  $nativeNotifyPrefs,
  dispatchNativeNotification,
  setNativeNotifyEnabled,
  setNativeNotifyKind
} from './native-notifications'

const send = vi.mocked(sendNotification)
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
      kinds: { approval: true, backgroundDone: true, input: true, turnDone: true, turnError: true }
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
