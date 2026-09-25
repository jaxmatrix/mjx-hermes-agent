import { describe, expect, it } from 'vitest'

import {
  connectionChromeBase,
  RECONNECTED_FLASH_MS,
  stepConnectionChrome
} from './mobile-connection-chrome'

describe('connectionChromeBase', () => {
  it('is idle when never connected', () => {
    expect(connectionChromeBase({ gatewayState: 'closed', hasConnected: false })).toBe('idle')
  })

  it('is idle when connected and open', () => {
    expect(connectionChromeBase({ gatewayState: 'open', hasConnected: true })).toBe('idle')
  })

  it('is reconnecting when hasConnected and socket is down', () => {
    expect(connectionChromeBase({ gatewayState: 'closed', hasConnected: true })).toBe('reconnecting')
  })
})

describe('stepConnectionChrome', () => {
  it('stays reconnecting while the base is reconnecting', () => {
    expect(
      stepConnectionChrome({
        base: 'reconnecting',
        flashUntil: 5000,
        now: 1000,
        prevBase: 'idle'
      })
    ).toEqual({ flashUntil: null, status: 'reconnecting' })
  })

  it('starts a green flash when leaving reconnecting', () => {
    expect(
      stepConnectionChrome({
        base: 'idle',
        flashUntil: null,
        now: 2000,
        prevBase: 'reconnecting'
      })
    ).toEqual({ flashUntil: 2000 + RECONNECTED_FLASH_MS, status: 'reconnected' })
  })

  it('keeps reconnected until flashUntil, then idle', () => {
    expect(
      stepConnectionChrome({
        base: 'idle',
        flashUntil: 3000,
        now: 2500,
        prevBase: 'idle'
      })
    ).toEqual({ flashUntil: 3000, status: 'reconnected' })

    expect(
      stepConnectionChrome({
        base: 'idle',
        flashUntil: 3000,
        now: 3000,
        prevBase: 'idle'
      })
    ).toEqual({ flashUntil: null, status: 'idle' })
  })
})
