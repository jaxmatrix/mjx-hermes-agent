/**
 * prepareBotSource: active rows activate via ensureAgent; remote rows lease via
 * probeAgent without switching the primary gateway.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RosterRow } from './types'

const { ensureAgent, noteBotConnectionOpened, probeAgent } = vi.hoisted(() => ({
  ensureAgent: vi.fn(),
  noteBotConnectionOpened: vi.fn(),
  probeAgent: vi.fn()
}))

vi.mock('@hermes/plugin-sdk', () => ({
  BOT_CHAT_SESSION_HYDRATION_TIMEOUT_MS: 15_000,
  host: { ensureAgent, probeAgent, requestProfile: vi.fn() },
  universalHost: { ensureAgent, probeAgent, requestProfile: vi.fn() }
}))

vi.mock('./relay', () => ({ noteBotConnectionOpened }))

vi.mock('./routing', () => ({
  backendTargetProfile: (_route: unknown, name: string) => name,
  botConnectionRoute: (bot: RosterRow) => bot.route ?? null,
  botRosterMeta: () => ({}),
  botWorkspaceOwnerKey: () => 'bot:x',
  requestForBot: vi.fn()
}))

vi.mock('./data', () => ({
  $botMeta: { get: () => ({}), set: vi.fn() },
  botMetaKey: (bot: { name?: string }) => bot?.name ?? '',
  botOwner: () => ({ bot: {}, key: '', name: '', route: null }),
  persistBotMetaSnapshot: vi.fn(),
  saveBotMeta: vi.fn()
}))

vi.mock('./shared', () => ({ getPluginCtx: () => null }))

async function load() {
  vi.resetModules()

  return import('./canonical-chat')
}

beforeEach(() => {
  ensureAgent.mockReset().mockResolvedValue(undefined)
  probeAgent.mockReset().mockResolvedValue({ connectionId: 'https://gw-b.test', ok: true, profile: 'worker' })
  noteBotConnectionOpened.mockReset()
})

describe('prepareBotSource', () => {
  it('activates via ensureAgent for an active-source row (no route)', async () => {
    const { prepareBotSource } = await load()
    const bot = {
      connectionId: 'https://gw-a.test',
      name: 'default',
      sourceScoped: true
    } as RosterRow

    await prepareBotSource(bot)

    expect(noteBotConnectionOpened).toHaveBeenCalledWith('https://gw-a.test')
    expect(ensureAgent).toHaveBeenCalledWith('https://gw-a.test', 'default')
    expect(probeAgent).not.toHaveBeenCalled()
  })

  it('leases via probeAgent for a routed remote row — never ensureAgent', async () => {
    const { prepareBotSource } = await load()
    const bot = {
      connectionId: 'https://gw-b.test',
      name: 'worker',
      route: {
        connectionId: 'https://gw-b.test',
        mode: 'remote',
        profile: 'worker',
        targetProfile: 'worker'
      },
      sourceScoped: true
    } as RosterRow

    await prepareBotSource(bot)

    expect(noteBotConnectionOpened).toHaveBeenCalledWith('https://gw-b.test')
    expect(probeAgent).toHaveBeenCalledWith('https://gw-b.test', 'worker')
    expect(ensureAgent).not.toHaveBeenCalled()
  })

  it('throws on lease failure so open toasts once', async () => {
    probeAgent.mockResolvedValueOnce({ error: 'AGENT_ROUTING_UNAVAILABLE', ok: false })
    const { prepareBotSource } = await load()
    const bot = {
      connectionId: 'https://gw-b.test',
      name: 'worker',
      route: {
        connectionId: 'https://gw-b.test',
        mode: 'remote',
        profile: 'worker',
        targetProfile: 'worker'
      },
      sourceScoped: true
    } as RosterRow

    await expect(prepareBotSource(bot)).rejects.toThrow(/AGENT_ROUTING_UNAVAILABLE/)
    expect(ensureAgent).not.toHaveBeenCalled()
  })
})
