import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/platform', () => ({
  IS_DESKTOP: true,
  IS_TAURI: true
}))

import { launchFlagsBridge } from './launch-flags'

describe('hermesDesktop launch flags', () => {
  it('exposes sync booleans', () => {
    expect(launchFlagsBridge.localModelsEnabled).toBe(true)
    expect(launchFlagsBridge.guestOnboardingEnabled).toBe(false)
    expect(launchFlagsBridge.skipIntro).toBe(false)
  })
})
