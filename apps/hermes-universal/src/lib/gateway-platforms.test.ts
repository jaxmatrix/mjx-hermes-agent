import { describe, expect, it } from 'vitest'

import { platformStatusId, splitPlatformStatusKey } from '@/lib/gateway-platforms'

describe('splitPlatformStatusKey', () => {
  it('splits a profile-namespaced key', () => {
    expect(splitPlatformStatusKey('work:telegram')).toEqual({ platform: 'telegram', profile: 'work' })
  })

  it('leaves a plain key as its own platform with no profile', () => {
    expect(splitPlatformStatusKey('telegram')).toEqual({ platform: 'telegram', profile: '' })
  })

  it('keeps a malformed key whole rather than yielding an empty half', () => {
    expect(splitPlatformStatusKey(':telegram')).toEqual({ platform: ':telegram', profile: '' })
    expect(splitPlatformStatusKey('work:')).toEqual({ platform: 'work:', profile: '' })
  })

  it('splits on the FIRST colon, so a platform id may contain one', () => {
    expect(splitPlatformStatusKey('work:matrix:beta')).toEqual({ platform: 'matrix:beta', profile: 'work' })
  })

  it('gives the statusbar an id its api_server filter and icon table can match', () => {
    // The two live consumers: `id !== 'api_server'` and PLATFORM_ICONS[id].
    // Asserting the raw key here would pass on the pre-fix code.
    expect(platformStatusId('work:api_server')).toBe('api_server')
    expect(platformStatusId('work:telegram')).toBe('telegram')
    expect(platformStatusId('api_server')).toBe('api_server')
  })
})
