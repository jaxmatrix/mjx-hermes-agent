import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MessagingPlatformInfo } from '@/types/hermes'

const platform = (over: Partial<MessagingPlatformInfo>): MessagingPlatformInfo => ({
  id: 'telegram',
  name: 'Telegram',
  description: '',
  docs_url: '',
  configured: false,
  enabled: false,
  gateway_running: true,
  env_vars: [],
  ...over
})

vi.mock('@/hermes', () => ({
  getMessagingPlatforms: vi.fn(async () => ({
    platforms: [platform({ id: 'telegram', name: 'Telegram' }), platform({ id: 'discord', name: 'Discord', enabled: true })]
  })),
  updateMessagingPlatform: vi.fn(async () => ({ ok: true, platform: 'telegram' })),
  testMessagingPlatform: vi.fn(async () => ({ ok: true, message: 'Connected' }))
}))

import { updateMessagingPlatform } from '@/hermes'

import { $platforms, refreshMessaging, setPlatformEnabled } from './messaging'

const update = vi.mocked(updateMessagingPlatform)

describe('messaging store', () => {
  beforeEach(() => {
    update.mockClear()
    $platforms.set([])
  })
  afterEach(() => $platforms.set([]))

  it('loads platforms', async () => {
    await refreshMessaging()
    expect($platforms.get().map(p => p.id)).toEqual(['telegram', 'discord'])
  })

  it('enables a platform optimistically', async () => {
    await refreshMessaging()
    await setPlatformEnabled('telegram', true)
    expect(update).toHaveBeenCalledWith('telegram', { enabled: true })
    expect($platforms.get().find(p => p.id === 'telegram')?.enabled).toBe(true)
  })
})
