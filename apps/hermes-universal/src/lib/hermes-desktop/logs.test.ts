import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][],
  fail: new Set<string>()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])

    if (native.fail.has(command)) {
      throw new Error('refused')
    }

    if (command === 'logs_reveal') {
      return { ok: true, path: '/home/me/.hermes/logs/desktop.log' }
    }

    if (command === 'logs_recent') {
      return { path: '/home/me/.hermes/logs/desktop.log', lines: ['a', 'b'] }
    }

    if (command === 'logs_root') {
      return '/home/me/.hermes/logs'
    }

    return undefined
  })
}))

import { logsBridge } from './logs'

beforeEach(() => {
  native.calls = []
  native.fail.clear()
})

describe('hermesDesktop logs', () => {
  it('revealLogs / getRecentLogs / logsRoot invoke the Rust commands', async () => {
    await expect(logsBridge.revealLogs()).resolves.toEqual({
      ok: true,
      path: '/home/me/.hermes/logs/desktop.log'
    })
    await expect(logsBridge.getRecentLogs()).resolves.toEqual({
      path: '/home/me/.hermes/logs/desktop.log',
      lines: ['a', 'b']
    })
    await expect(logsBridge.logsRoot!()).resolves.toBe('/home/me/.hermes/logs')

    expect(native.calls).toEqual([
      ['logs_reveal', undefined],
      ['logs_recent', undefined],
      ['logs_root', undefined]
    ])
  })

  it('reportRendererError is fire-and-forget with Electron’s report shape', async () => {
    logsBridge.reportRendererError!({
      label: 'main',
      boundary: 'ErrorBoundary',
      message: 'boom',
      componentStack: '  in App'
    })

    await vi.waitFor(() => {
      expect(native.calls).toEqual([
        [
          'report_renderer_error',
          {
            report: {
              label: 'main',
              boundary: 'ErrorBoundary',
              message: 'boom',
              componentStack: '  in App'
            }
          }
        ]
      ])
    })
  })
})
