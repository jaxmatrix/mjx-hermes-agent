import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][],
  foundHandler: null as null | ((payload: unknown) => void)
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])
  })
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (e: { payload: unknown }) => void) => {
    native.foundHandler = payload => handler({ payload })

    return () => {
      native.foundHandler = null
    }
  })
}))

import { findInPageBridge } from './find-in-page'

beforeEach(() => {
  native.calls = []
  native.foundHandler = null
})

describe('hermesDesktop find-in-page', () => {
  it('find / stop invoke the Rust commands', async () => {
    await expect(findInPageBridge.findInPage('needle', { forward: true, findNext: false })).resolves.toEqual({
      count: 0
    })
    await findInPageBridge.stopFindInPage()

    expect(native.calls).toEqual([
      ['find_in_page', { query: 'needle', forward: true, findNext: false }],
      ['stop_find_in_page', undefined]
    ])
  })

  it('onFoundInPage maps the engine count', async () => {
    const rows: unknown[] = []
    const stop = findInPageBridge.onFoundInPage(result => rows.push(result))

    await vi.waitFor(() => expect(native.foundHandler).toBeTruthy())
    native.foundHandler!(3)

    expect(rows).toEqual([{ activeMatchOrdinal: 0, count: 3 }])
    stop()
  })
})
