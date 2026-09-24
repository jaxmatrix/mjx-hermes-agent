import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][]
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])

    if (command === 'mcp_oauth_listen') {
      return { id: '1', redirectUri: 'http://127.0.0.1:9/callback' }
    }

    if (command === 'mcp_oauth_wait') {
      return { code: 'c', error: null, iss: null, state: 's' }
    }

    return true
  })
}))

import { mcpOauthBridge } from './mcp-oauth'

beforeEach(() => {
  native.calls = []
})

describe('hermesDesktop.mcpOauth', () => {
  it('listen / wait / cancel invoke the Rust commands', async () => {
    await expect(mcpOauthBridge.mcpOauth!.listen()).resolves.toEqual({
      id: '1',
      redirectUri: 'http://127.0.0.1:9/callback'
    })
    await expect(mcpOauthBridge.mcpOauth!.wait('1', 5000)).resolves.toMatchObject({ code: 'c' })
    await expect(mcpOauthBridge.mcpOauth!.cancel('1')).resolves.toBe(true)

    expect(native.calls).toEqual([
      ['mcp_oauth_listen', undefined],
      ['mcp_oauth_wait', { id: '1', timeoutMs: 5000 }],
      ['mcp_oauth_cancel', { id: '1' }]
    ])
  })
})
