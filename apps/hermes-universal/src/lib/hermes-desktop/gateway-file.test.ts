import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][],
  dest: '/out/report.md' as string | null
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])
  })
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(async () => native.dest)
}))

import { gatewayFileBridge } from './gateway-file'

beforeEach(() => {
  native.calls = []
  native.dest = '/out/report.md'
})

describe('hermesDesktop.saveGatewayFile', () => {
  it('picks a path then streams via download_file', async () => {
    await expect(
      gatewayFileBridge.saveGatewayFile!({
        path: '/gateway/files/report.md',
        suggestedName: 'report.md'
      })
    ).resolves.toEqual({ saved: true, path: '/out/report.md' })

    expect(native.calls).toEqual([['download_file', { path: '/gateway/files/report.md', dest: '/out/report.md' }]])
  })

  it('returns canceled when the save dialog is dismissed', async () => {
    native.dest = null

    await expect(gatewayFileBridge.saveGatewayFile!({ path: '/gateway/a.bin' })).resolves.toEqual({
      canceled: true,
      saved: false
    })

    expect(native.calls).toEqual([])
  })
})
