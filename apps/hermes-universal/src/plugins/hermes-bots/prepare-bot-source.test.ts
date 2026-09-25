/**
 * prepareBotSource: active rows activate via ensureAgent; routed remotes only
 * note the connection opened — same as Electron Desktop (first requestProfile
 * dials via requestGatewayForAgent). Never ensureAgent on routed rows.
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

  it('for a routed remote only notes opened — never ensureAgent or probeAgent', async () => {
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
    expect(probeAgent).not.toHaveBeenCalled()
    expect(ensureAgent).not.toHaveBeenCalled()
  })
})
