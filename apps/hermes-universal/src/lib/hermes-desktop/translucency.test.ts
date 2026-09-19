import { beforeEach, describe, expect, it, vi } from 'vitest'

const os = vi.hoisted(() => ({ platform: 'linux', version: '6.1.0' }))
const native = vi.hoisted(() => ({ calls: [] as [string, unknown][], glassBacked: true }))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: () => {
    if (os.platform === 'none') {
      throw new Error('no runtime')
    }

    return os.platform
  },
  version: () => os.version
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: unknown) => void native.calls.push([command, args]))
}))
vi.mock('@/store/windows', () => ({ isGlassBackedWindow: () => native.glassBacked }))

const flush = () => new Promise(resolve => setTimeout(resolve, 50))

async function bridge(platform: string, version = '1.0.0') {
  os.platform = platform
  os.version = version
  vi.resetModules()

  return (await import('./translucency')).translucencyBridge()
}

const STATE = { fade: 0, intensity: 40, material: 'popover', mode: 'glass', scope: 'sidebar' } as const

beforeEach(() => {
  native.calls = []
  native.glassBacked = true
})

describe('the two pre-paint facts', () => {
  // `appearance/{linux,mac,win,none}.rs::probe`, answered without an await.
  it('answers what Rust’s probe answers, per OS', async () => {
    expect(await bridge('linux')).toMatchObject({ glassSupported: false, translucencySupported: true })
    expect(await bridge('macos')).toMatchObject({ glassSupported: true, translucencySupported: true })
    expect(await bridge('windows', '10.0.22631')).toMatchObject({ glassSupported: true, translucencySupported: true })
    expect(await bridge('windows', '10.0.19045')).toMatchObject({ glassSupported: false, translucencySupported: true })
    expect(await bridge('windows', 'unknown')).toMatchObject({ glassSupported: false })
  })

  it('stays absent on a phone and with no runtime, so desktop’s own fallback applies', async () => {
    expect(await bridge('android')).toEqual({})
    expect(await bridge('ios')).toEqual({})
    expect(await bridge('freebsd')).toEqual({})
    expect(await bridge('none')).toEqual({})
  })
})

describe('hermesDesktop.setTranslucency', () => {
  it('sends the native half only — scope moves no native property', async () => {
    const { setTranslucency } = await bridge('macos')

    expect(setTranslucency!(STATE)).toBeUndefined()

    await vi.waitFor(() =>
      expect(native.calls).toEqual([
        ['appearance_set_glass', { state: { fade: 0, intensity: 40, material: 'popover', mode: 'glass' } }]
      ])
    )
  })

  it('leaves a satellite’s window alone', async () => {
    native.glassBacked = false

    const { setTranslucency } = await bridge('macos')

    setTranslucency!(STATE)
    await flush()

    expect(native.calls).toEqual([])
  })
})
