import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-haptics', () => ({
  impactFeedback: vi.fn(async () => undefined),
  vibrate: vi.fn(async () => undefined)
}))

// Default to Android; the iOS suite re-imports with this flipped.
vi.mock('@/lib/platform', () => ({ IS_IOS: false }))

import { impactFeedback, vibrate } from '@tauri-apps/plugin-haptics'

import { tauriHapticTrigger } from './haptics-tauri'

const mockVibrate = vi.mocked(vibrate)
const mockImpact = vi.mocked(impactFeedback)

// The exact patterns lib/haptics.ts sends for these intents. Copied rather than
// imported because HAPTIC_INTENTS is module-private there — which is the whole
// reason this renderer sees patterns instead of intents.
const SELECTION = [{ duration: 16, intensity: 0.52 }]

const SUBMIT = [
  { duration: 24, intensity: 0.58 },
  { delay: 48, duration: 36, intensity: 0.82 }
]

const SUCCESS = [
  { duration: 28, intensity: 0.5 },
  { delay: 42, duration: 30, intensity: 0.68 },
  { delay: 48, duration: 38, intensity: 0.86 }
]

describe('tauriHapticTrigger (Android)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('plays one vibration per pulse, using each pulse duration', async () => {
    await tauriHapticTrigger(SUCCESS)

    expect(mockVibrate.mock.calls.map(([ms]) => ms)).toEqual([28, 30, 38])
    expect(mockImpact).not.toHaveBeenCalled()
  })

  it('preserves rhythm so different intents stay distinguishable', async () => {
    await tauriHapticTrigger(SELECTION)
    const selection = mockVibrate.mock.calls.length

    vi.clearAllMocks()
    await tauriHapticTrigger(SUBMIT)
    const submit = mockVibrate.mock.calls.length

    expect(selection).toBe(1)
    expect(submit).toBe(2)
  })

  it('rounds and floors durations to at least 1ms', async () => {
    await tauriHapticTrigger([{ duration: 0.2 }, { duration: 10.6 }])

    expect(mockVibrate.mock.calls.map(([ms]) => ms)).toEqual([1, 11])
  })

  it('resolves a named web-haptics preset', async () => {
    await tauriHapticTrigger('selection')

    expect(mockVibrate).toHaveBeenCalledTimes(1)
  })

  it('ignores an unknown preset instead of throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(tauriHapticTrigger('not-a-preset')).resolves.toBeUndefined()
    expect(mockVibrate).not.toHaveBeenCalled()
  })

  it('rejects a negative duration without vibrating', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await tauriHapticTrigger([{ duration: -5 }])

    expect(mockVibrate).not.toHaveBeenCalled()
  })

  it('falls back to navigator.vibrate when the plugin throws', async () => {
    mockVibrate.mockRejectedValueOnce(new Error('no actuator'))
    const navVibrate = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, vibrate: navVibrate })

    await tauriHapticTrigger(SELECTION)

    expect(navVibrate).toHaveBeenCalledWith(16)
    vi.unstubAllGlobals()
  })

  it('does nothing for an empty pattern', async () => {
    await tauriHapticTrigger([])

    expect(mockVibrate).not.toHaveBeenCalled()
  })
})

describe('tauriHapticTrigger (iOS)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.doMock('@/lib/platform', () => ({ IS_IOS: true }))
  })

  async function iosTrigger() {
    return (await import('./haptics-tauri')).tauriHapticTrigger
  }

  it('maps pulse intensity onto impact styles, one per pulse', async () => {
    await (
      await iosTrigger()
    )(SUCCESS)

    expect(mockImpact.mock.calls.map(([style]) => style)).toEqual(['light', 'medium', 'rigid'])
    expect(mockVibrate).not.toHaveBeenCalled()
  })

  it('spans the full style range across the intensity scale', async () => {
    await (
      await iosTrigger()
    )([
      { duration: 10, intensity: 0.1 },
      { duration: 10, intensity: 0.5 },
      { duration: 10, intensity: 0.7 },
      { duration: 10, intensity: 0.85 },
      { duration: 10, intensity: 1 }
    ])

    expect(mockImpact.mock.calls.map(([style]) => style)).toEqual(['soft', 'light', 'medium', 'rigid', 'heavy'])
  })

  it('uses the options fallback for pulses with no intensity of their own', async () => {
    await (
      await iosTrigger()
    )([{ duration: 10 }], { intensity: 0.95 })

    expect(mockImpact).toHaveBeenCalledWith('heavy')
  })

  it("defaults that fallback to web-haptics' 0.5", async () => {
    await (
      await iosTrigger()
    )([{ duration: 10 }])

    expect(mockImpact).toHaveBeenCalledWith('light')
  })

  it('does not let an explicit pulse intensity be overridden by options', async () => {
    await (
      await iosTrigger()
    )([{ duration: 10, intensity: 0.1 }], { intensity: 1 })

    expect(mockImpact).toHaveBeenCalledWith('soft')
  })
})
