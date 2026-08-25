import { describe, expect, it, vi } from 'vitest'

import { completeMcpDesktopOAuth, McpOAuthCancelled, type McpOAuthFlow } from './mcp-dashboard-oauth'

const flow = (over: Partial<McpOAuthFlow> = {}): McpOAuthFlow => ({
  flow_id: 'flow-1',
  server_name: 'reports',
  status: 'authorization_required',
  authorization_url: 'https://idp.example/authorize',
  error: null,
  ...over
})

describe('completeMcpDesktopOAuth', () => {
  it('opens the returned authorization URL and polls through approval', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)

    const status = vi
      .fn()
      .mockResolvedValueOnce(flow())
      .mockResolvedValueOnce(flow({ status: 'approved', tools: [{ name: 'list_reports', description: 'List' }] }))

    const result = await completeMcpDesktopOAuth({
      serverName: 'reports',
      start: vi.fn().mockResolvedValue(flow()),
      status,
      openExternal,
      sleep: async () => {}
    })

    expect(openExternal).toHaveBeenCalledWith('https://idp.example/authorize')
    expect(result.status).toBe('approved')
  })

  it('retries a transient status failure', async () => {
    const status = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(flow({ flow_id: 'flow-2', status: 'approved', tools: [] }))

    const result = await completeMcpDesktopOAuth({
      serverName: 'reports',
      start: vi.fn().mockResolvedValue(flow({ flow_id: 'flow-2' })),
      status,
      openExternal: vi.fn().mockResolvedValue(undefined),
      sleep: async () => {}
    })

    expect(result.status).toBe('approved')
    expect(status).toHaveBeenCalledTimes(2)
  })

  // Identity: the poll must resolve to the flow THIS call started. The backend
  // hands back a session id that is not the server name and not the id of any
  // other in-flight flow, so the fixture answers only for `flow-b` and errors
  // for everything else — polling by server name (or a stale id) goes red.
  it('polls the flow id the start call returned, not the server name', async () => {
    const status = vi.fn(async (flowId: string) =>
      flowId === 'flow-b'
        ? flow({ flow_id: 'flow-b', status: 'approved', tools: [] })
        : flow({ flow_id: flowId, status: 'error', error: `polled the wrong flow: ${flowId}` })
    )

    const result = await completeMcpDesktopOAuth({
      serverName: 'reports',
      start: vi.fn().mockResolvedValue(flow({ flow_id: 'flow-b' })),
      status,
      openExternal: vi.fn().mockResolvedValue(undefined),
      sleep: async () => {}
    })

    expect(status).toHaveBeenCalledWith('flow-b')
    expect(result.status).toBe('approved')
  })

  it('cancels the flow SERVER-SIDE and rejects with McpOAuthCancelled', async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: true, status: 'error' })
    // Never approves — only the cancel gate can end this loop.
    const status = vi.fn().mockResolvedValue(flow({ flow_id: 'flow-c' }))

    await expect(
      completeMcpDesktopOAuth({
        serverName: 'reports',
        start: vi.fn().mockResolvedValue(flow({ flow_id: 'flow-c' })),
        status,
        openExternal: vi.fn().mockResolvedValue(undefined),
        cancelled: () => true,
        cancel,
        sleep: async () => {}
      })
    ).rejects.toBeInstanceOf(McpOAuthCancelled)

    expect(cancel).toHaveBeenCalledWith('flow-c')
    // Cancelled before the first status poll — no wasted round trip.
    expect(status).not.toHaveBeenCalled()
  })

  it('still rejects when the server-side cancel request fails', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('gateway gone'))

    await expect(
      completeMcpDesktopOAuth({
        serverName: 'reports',
        start: vi.fn().mockResolvedValue(flow({ flow_id: 'flow-d' })),
        status: vi.fn().mockResolvedValue(flow({ flow_id: 'flow-d' })),
        openExternal: vi.fn().mockResolvedValue(undefined),
        cancelled: () => true,
        cancel,
        sleep: async () => {}
      })
    ).rejects.toBeInstanceOf(McpOAuthCancelled)
  })
})
