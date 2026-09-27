import { describe, expect, it, vi, beforeEach } from 'vitest'

const { requestForBot, hostRequest } = vi.hoisted(() => ({
  hostRequest: vi.fn(),
  requestForBot: vi.fn()
}))

vi.mock('@hermes/plugin-sdk', () => ({
  Button: 'button',
  Input: 'input',
  universalHost: {
    request: hostRequest,
    notify: vi.fn(),
    completeMcpOAuth: vi.fn(),
    state: { connectionId: { get: () => 'active' }, profile: { get: () => 'default' } }
  },
  useI18n: () => ({ t: { common: { cancel: 'Cancel' } } })
}))

vi.mock('./routing', () => ({ requestForBot }))

import { mcpHomeForTest, mcpRpcForTest } from './mcp-setup'

describe('mcp home scope', () => {
  beforeEach(() => {
    hostRequest.mockReset()
    requestForBot.mockReset().mockResolvedValue({ ok: true })
  })

  it('keeps a bare profile string as the gateway profile name', () => {
    expect(mcpHomeForTest('research')).toEqual({ profile: 'research' })
  })

  it('splits connectionId from the profile name for source-scoped bots', () => {
    expect(
      mcpHomeForTest({
        connectionId: 'https://gw-b.test',
        profile: 'worker'
      })
    ).toEqual({
      connectionId: 'https://gw-b.test',
      profile: 'worker'
    })
  })

  it('never treats the scope object itself as the profile param', () => {
    const home = mcpHomeForTest({
      connectionId: 'https://gw-b.test',
      profile: 'worker'
    })

    expect(typeof home?.profile).toBe('string')
    expect(home?.profile).not.toEqual(expect.objectContaining({ connectionId: expect.anything() }))
  })

  it('routes source-scoped mcp.servers.* via requestForBot with a string profile', async () => {
    await mcpRpcForTest(
      'mcp.servers.add',
      { name: 'filesystem', preset: 'filesystem' },
      { connectionId: 'https://gw-b.test', profile: 'worker' }
    )

    expect(requestForBot).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'https://gw-b.test',
        name: 'worker',
        sourceScoped: true
      }),
      'mcp.servers.add',
      expect.objectContaining({
        name: 'filesystem',
        profile: 'worker'
      })
    )
    expect(hostRequest).not.toHaveBeenCalled()
  })

  it('keeps local bare profiles on host.request', async () => {
    await mcpRpcForTest('mcp.servers.list', {}, 'default')

    expect(hostRequest).toHaveBeenCalledWith(
      'mcp.servers.list',
      expect.objectContaining({ profile: 'default' })
    )
    expect(requestForBot).not.toHaveBeenCalled()
  })
})