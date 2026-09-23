import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined)
}))

vi.mock('@/lib/platform', () => ({
  IS_DESKTOP: true,
  IS_TAURI: true
}))

vi.mock('@/lib/storage', () => ({
  readKey: vi.fn(() => null)
}))

describe('chatOnboardingBridge', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('invokes grow with request + zoom factor', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const { chatOnboardingBridge } = await import('./chat-onboarding')

    chatOnboardingBridge.chatOnboarding!.grow({
      top: 10,
      bottom: 20,
      left: 30,
      right: 40,
      minWidth: 768
    })

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('chat_onboarding_grow', {
        request: { top: 10, bottom: 20, left: 30, right: 40, minWidth: 768 },
        zoom: 0.9
      })
    })
  })

  it('invokes soloBoot', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const { chatOnboardingBridge } = await import('./chat-onboarding')

    chatOnboardingBridge.chatOnboarding!.soloBoot!()

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('chat_onboarding_solo_boot', undefined)
    })
  })
})
