import { beforeEach, describe, expect, it } from 'vitest'

import { appearanceForBotChat, parseBotWorkspaceOwnerKey } from './bubble-avatar'
import { $botMeta } from './data'

import { $botChatScopes } from '@/store/session-states'

describe('parseBotWorkspaceOwnerKey', () => {
  it('splits bot:connectionId::profile', () => {
    expect(parseBotWorkspaceOwnerKey('bot:local::radar')).toEqual({
      connectionId: 'local',
      profile: 'radar'
    })
  })

  it('accepts a bare bot:profile degraded key', () => {
    expect(parseBotWorkspaceOwnerKey('bot:default')).toEqual({ profile: 'default' })
  })

  it('rejects non-bot keys', () => {
    expect(parseBotWorkspaceOwnerKey('local::default')).toBeNull()
    expect(parseBotWorkspaceOwnerKey(null)).toBeNull()
  })
})

describe('appearanceForBotChat', () => {
  beforeEach(() => {
    $botChatScopes.set({})
    $botMeta.set({})
  })

  it('uses scope owner + $botMeta shape/color', () => {
    $botChatScopes.set({
      'sess-1': {
        workspaceMode: 'bots',
        workspaceOwnerKey: 'bot:local::cow-bot'
      }
    })
    $botMeta.set({
      'local::cow-bot': { shape: 'pill', color: '#ec4899' }
    })

    const face = appearanceForBotChat('sess-1')

    expect(face?.name).toBe('cow-bot')
    expect(face?.shape).toBe('pill')
    expect(face?.fill).toBe('#ec4899')
  })

  it('falls back to the bubble hint when scope is missing', () => {
    $botMeta.set({
      default: { shape: 'squircle', color: '#8b5cf6', custom: true }
    })

    const face = appearanceForBotChat('sess-2', { connectionId: 'local', profile: 'default' })

    expect(face?.name).toBe('default')
    expect(face?.shape).toBe('squircle')
    expect(face?.fill).toBe('#8b5cf6')
  })

  it('still returns a deterministic face with no meta', () => {
    const face = appearanceForBotChat(null, { profile: 'hex-bot' })

    expect(face?.name).toBe('hex-bot')
    expect(face?.shape).toBeTruthy()
    expect(face?.fill).toBeTruthy()
  })
})
