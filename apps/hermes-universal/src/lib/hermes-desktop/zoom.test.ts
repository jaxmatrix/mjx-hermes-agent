import { beforeEach, describe, expect, it, vi } from 'vitest'

const webview = vi.hoisted(() => ({ fail: false, platform: 'linux', zooms: [] as number[] }))

vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => webview.platform }))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    setZoom: async (factor: number) => {
      if (webview.fail) {
        throw new Error('no zoom lever')
      }

      webview.zooms.push(factor)
    }
  })
}))

const KEY = 'hermes.zoomPercent'
const flush = () => new Promise(resolve => setTimeout(resolve, 25))

async function bridge() {
  vi.resetModules()

  return (await import('./zoom')).zoomBridge
}

beforeEach(() => {
  webview.fail = false
  webview.platform = 'linux'
  webview.zooms = []
  window.localStorage.clear()
})

describe('hermesDesktop.zoom', () => {
  // `store/zoom.ts` guards the namespace, then calls `get` and `onChanged` bare.
  it('is the whole namespace desktop calls', async () => {
    expect(Object.keys(await bridge()).sort()).toEqual(['factor', 'get', 'onChanged', 'setPercent'])
  })

  it('get applies the persisted size once and answers { level, percent }', async () => {
    window.localStorage.setItem(KEY, '120')

    const zoom = await bridge()
    const state = await zoom.get()

    await zoom.get()

    expect(state.percent).toBe(120)
    expect(Math.pow(1.2, state.level)).toBeCloseTo(1.2)
    expect(webview.zooms).toEqual([1.2])
    expect(zoom.factor!()).toBe(1.2)
  })

  it('starts at desktop’s 90% on a desktop OS and at the webview’s own 100% on a phone', async () => {
    expect((await (await bridge()).get()).percent).toBe(90)

    webview.platform = 'android'
    expect((await (await bridge()).get()).percent).toBe(100)
  })

  it('setPercent clamps, persists, applies, then tells every listener', async () => {
    const zoom = await bridge()
    const heard: number[] = []

    await zoom.get()
    webview.zooms = []

    const off = zoom.onChanged(({ percent }) => void heard.push(percent))

    zoom.setPercent(110)
    zoom.setPercent(9999)
    await vi.waitFor(() => expect(heard).toEqual([110, 200]))
    off()
    zoom.setPercent(100)
    await vi.waitFor(() => expect(webview.zooms).toHaveLength(3))

    expect(heard).toEqual([110, 200])
    expect(window.localStorage.getItem(KEY)).toBe('100')
    expect(webview.zooms).toEqual([1.1, 2, 1])
  })

  it('a size the webview refused is not reported, persisted or announced', async () => {
    webview.fail = true

    const zoom = await bridge()
    const heard: number[] = []

    zoom.onChanged(({ percent }) => void heard.push(percent))
    zoom.setPercent(150)
    await flush()
    await flush()

    expect(zoom.factor!()).toBe(1)
    expect(heard).toEqual([])
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })
})
