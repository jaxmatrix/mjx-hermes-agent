import { describe, expect, it } from 'vitest'

import { IS_ANDROID, IS_MOBILE, LOCAL_MODE_SUPPORTED, PLATFORM } from './platform'

// In jsdom there is no Tauri runtime, so platform() throws and the helper falls
// back to 'unknown' → desktop-like defaults.
describe('platform gating (no Tauri runtime)', () => {
  it('falls back to unknown', () => {
    expect(PLATFORM).toBe('unknown')
  })

  it('is not detected as mobile', () => {
    expect(IS_ANDROID).toBe(false)
    expect(IS_MOBILE).toBe(false)
  })

  it('allows local mode off-device', () => {
    expect(LOCAL_MODE_SUPPORTED).toBe(true)
  })
})
