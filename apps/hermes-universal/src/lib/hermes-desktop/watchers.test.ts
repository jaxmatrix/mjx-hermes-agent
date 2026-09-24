import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][],
  listenHandlers: [] as Array<(event: { payload: unknown }) => void>
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])

    if (command === 'stop_preview_file_watch') {
      return true
    }

    return { id: 'w1', path: '/tmp/file.txt' }
  })
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    native.listenHandlers.push(handler)

    return () => {
      native.listenHandlers = native.listenHandlers.filter(h => h !== handler)
    }
  })
}))

import { watchersBridge } from './watchers'

beforeEach(() => {
  native.calls = []
  native.listenHandlers = []
})

describe('hermesDesktop preview watchers', () => {
  it('invokes the Rust watch / stop commands', async () => {
    await expect(watchersBridge.watchPreviewFile('file:///tmp/a.txt')).resolves.toEqual({
      id: 'w1',
      path: '/tmp/file.txt'
    })
    await expect(watchersBridge.watchDirectory!('/tmp/plugins')).resolves.toMatchObject({ id: 'w1' })
    await expect(watchersBridge.stopPreviewFileWatch('w1')).resolves.toBe(true)

    expect(native.calls).toEqual([
      ['watch_preview_file', { url: 'file:///tmp/a.txt' }],
      ['watch_directory', { dir: '/tmp/plugins' }],
      ['stop_preview_file_watch', { id: 'w1' }]
    ])
  })

  it('relays hermes://preview-file-changed to onPreviewFileChanged', async () => {
    const seen: unknown[] = []
    const off = watchersBridge.onPreviewFileChanged(payload => void seen.push(payload))

    await vi.waitFor(() => expect(native.listenHandlers.length).toBe(1))
    native.listenHandlers[0]!({ payload: { id: 'w1', path: '/tmp/a.txt', url: 'file:///tmp/a.txt' } })

    expect(seen).toEqual([{ id: 'w1', path: '/tmp/a.txt', url: 'file:///tmp/a.txt' }])
    off()
  })
})
