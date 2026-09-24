import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][],
  progressHandler: null as null | ((payload: unknown) => void)
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])

    if (command === 'update_check') {
      return {
        source: 'github',
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        updateAvailable: true,
        downloadUrl: 'https://example.test',
        notesUrl: 'https://example.test/notes',
        checkedAtMs: 1_700_000_000_000,
        canSelfInstall: true,
        reason: null
      }
    }

    if (command === 'update_install') {
      throw new Error('unsupported_platform')
    }

    return undefined
  })
}))

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '9.9.9')
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: () => 'linux'
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (e: { payload: unknown }) => void) => {
    native.progressHandler = payload => handler({ payload })

    return () => {
      native.progressHandler = null
    }
  })
}))

import { updatesBridge } from './updates'

beforeEach(() => {
  native.calls = []
  native.progressHandler = null
})

describe('hermesDesktop.updates', () => {
  it('check maps release status onto DesktopUpdateStatus', async () => {
    await expect(updatesBridge.updates.check({ force: true })).resolves.toMatchObject({
      supported: true,
      updateAvailable: true,
      behind: null,
      currentVersion: '1.0.0',
      targetSha: 'v1.1.0',
      branch: 'release',
      fetchedAt: 1_700_000_000_000
    })

    expect(native.calls).toEqual([['update_check', { force: true }]])
  })

  it('apply surfaces unsupported installs as manual', async () => {
    await expect(updatesBridge.updates.apply()).resolves.toMatchObject({
      ok: false,
      manual: true
    })
  })

  it('getBranch / setBranch stay on the release channel', async () => {
    await expect(updatesBridge.updates.getBranch()).resolves.toEqual({ branch: 'release' })
    await expect(updatesBridge.updates.setBranch('nightly')).resolves.toEqual({ branch: 'nightly' })
  })

  it('onProgress maps byte progress to a DesktopUpdateProgress row', async () => {
    const rows: unknown[] = []
    const stop = updatesBridge.updates.onProgress(payload => rows.push(payload))

    // Allow the async listen() to settle.
    await vi.waitFor(() => expect(native.progressHandler).toBeTruthy())

    native.progressHandler!({ downloaded: 50, total: 100 })

    expect(rows).toEqual([
      {
        stage: 'fetch',
        message: 'Downloading update… 50%',
        percent: 50,
        error: null,
        at: expect.any(Number)
      }
    ])

    stop()
  })

  it('getVersion reads the Tauri package + OS platform', async () => {
    await expect(updatesBridge.getVersion()).resolves.toEqual({
      appVersion: '9.9.9',
      electronVersion: '',
      nodeVersion: '',
      platform: 'linux',
      hermesRoot: ''
    })
  })

  it('relaunchApp invokes relaunch_app when present', async () => {
    if (!updatesBridge.relaunchApp) {
      return
    }

    await updatesBridge.relaunchApp()
    expect(native.calls.at(-1)).toEqual(['relaunch_app', undefined])
  })
})
