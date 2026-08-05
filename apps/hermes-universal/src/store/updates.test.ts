import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateProgress } from '@/lib/updates'

const checkAppUpdate = vi.fn()
const installAppUpdate = vi.fn()
const unlisten = vi.fn()

let emitProgress: (progress: UpdateProgress) => void = () => {}

vi.mock('@/lib/updates', () => ({
  checkAppUpdate: (force: boolean) => checkAppUpdate(force),
  installAppUpdate: () => installAppUpdate(),
  onUpdateProgress: (handler: (progress: UpdateProgress) => void) => {
    emitProgress = handler

    return Promise.resolve(unlisten)
  }
}))

import {
  $appUpdate,
  $appUpdateChecking,
  $appUpdateFailed,
  $appUpdateInstallError,
  $appUpdateInstalling,
  $appUpdateProgress,
  __resetUpdateState,
  runUpdateCheck,
  runUpdateInstall
} from './updates'

const STATUS = {
  source: 'github',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  updateAvailable: true,
  downloadUrl: 'https://example.test/release',
  notesUrl: 'https://example.test/release',
  checkedAtMs: 1,
  canSelfInstall: true,
  reason: null
}

describe('update store', () => {
  beforeEach(() => {
    __resetUpdateState()
    checkAppUpdate.mockReset()
    installAppUpdate.mockReset()
    unlisten.mockReset()
  })

  it('stores the native result and clears the checking flag', async () => {
    checkAppUpdate.mockResolvedValue(STATUS)

    const pending = runUpdateCheck()
    expect($appUpdateChecking.get()).toBe(true)
    await pending

    expect($appUpdate.get()).toEqual(STATUS)
    expect($appUpdateChecking.get()).toBe(false)
    expect($appUpdateFailed.get()).toBe(false)
  })

  it('dedupes concurrent checks', async () => {
    checkAppUpdate.mockResolvedValue(STATUS)

    await Promise.all([runUpdateCheck(), runUpdateCheck(true), runUpdateCheck()])

    expect(checkAppUpdate).toHaveBeenCalledTimes(1)
  })

  it('flags a failure when the native command is unavailable', async () => {
    checkAppUpdate.mockResolvedValue(null)
    await runUpdateCheck()

    expect($appUpdate.get()).toBeNull()
    expect($appUpdateFailed.get()).toBe(true)
    expect($appUpdateChecking.get()).toBe(false)
  })

  it('survives a rejected check', async () => {
    checkAppUpdate.mockRejectedValue(new Error('boom'))
    await expect(runUpdateCheck()).resolves.toBeNull()

    expect($appUpdateFailed.get()).toBe(true)
    expect($appUpdateChecking.get()).toBe(false)
  })

  it('forwards download progress while installing', async () => {
    installAppUpdate.mockImplementation(() => new Promise(() => {}))

    void runUpdateInstall()
    // Let the listener attach before the first chunk arrives.
    await Promise.resolve()

    emitProgress({ downloaded: 512, total: 1024 })

    expect($appUpdateInstalling.get()).toBe(true)
    expect($appUpdateProgress.get()).toEqual({ downloaded: 512, total: 1024 })
  })

  // The success path never resolves in the real app — the native side restarts
  // the process — so the flag deliberately stays set rather than flickering the
  // button back to "Update now" mid-swap.
  it('stays in the installing state once the command is away', async () => {
    installAppUpdate.mockResolvedValue(undefined)

    await runUpdateInstall()

    expect($appUpdateInstalling.get()).toBe(true)
    expect($appUpdateInstallError.get()).toBeNull()
  })

  it('records the error and unsubscribes when the install fails', async () => {
    installAppUpdate.mockRejectedValue(new Error('signature mismatch'))

    await runUpdateInstall()

    expect($appUpdateInstallError.get()).toBe('signature mismatch')
    expect($appUpdateInstalling.get()).toBe(false)
    expect($appUpdateProgress.get()).toBeNull()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('ignores a second install while one is in flight', async () => {
    installAppUpdate.mockImplementation(() => new Promise(() => {}))

    void runUpdateInstall()
    await Promise.resolve()
    await runUpdateInstall()

    expect(installAppUpdate).toHaveBeenCalledTimes(1)
  })
})
