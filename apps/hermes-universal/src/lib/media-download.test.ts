/**
 * `downloadGatewayMediaFile` — native desktop save bridge.
 *
 * Universal routes downloads through `window.hermesDesktop.saveGatewayFile`
 * (same contract as apps/desktop). The old Tauri `download_file` queue lived
 * on a removed branch; behaviour is pinned in `media.remote.test.ts` alongside
 * the other remote-media paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { downloadGatewayMediaFile } from './media'

describe('downloadGatewayMediaFile on desktop bridge', () => {
  const saveGatewayFile = vi.fn(async () => ({ path: '/Users/me/Downloads/report.pdf', saved: true }))

  beforeEach(() => {
    saveGatewayFile.mockClear()
    vi.stubGlobal('window', { hermesDesktop: { saveGatewayFile } })
    $connection.set({ connectionId: 'work-ssh', mode: 'remote', profile: 'docker-gw' } as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    $connection.set(null)
  })

  it('asks the main process to save through the authenticated gateway connection', async () => {
    await expect(downloadGatewayMediaFile('/work/out/report.pdf')).resolves.toEqual({
      path: '/Users/me/Downloads/report.pdf',
      saved: true
    })

    expect(saveGatewayFile).toHaveBeenCalledWith({
      connectionId: 'work-ssh',
      path: '/work/out/report.pdf',
      profile: 'docker-gw',
      suggestedName: 'report.pdf'
    })
  })

  it('never fetches, so no CSP directive is in play', async () => {
    const fetchSpy = vi.fn()

    vi.stubGlobal('fetch', fetchSpy)

    await downloadGatewayMediaFile('/work/out/report.pdf')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('passes file paths through without rewriting them in the renderer', async () => {
    await downloadGatewayMediaFile('file:///work/out/q3%20report.pdf')

    expect(saveGatewayFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'file:///work/out/q3%20report.pdf' }))
  })

  it('rejects when the desktop bridge is unavailable', async () => {
    vi.stubGlobal('window', { hermesDesktop: {} })

    await expect(downloadGatewayMediaFile('/work/out/report.pdf')).rejects.toThrow('Desktop file download bridge')
  })
})
