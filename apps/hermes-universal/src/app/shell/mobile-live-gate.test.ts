import { describe, expect, it } from 'vitest'

import { isMobileShellLive } from './mobile-live-gate'

describe('isMobileShellLive', () => {
  it('is live when the socket is open, an active connection is published, and restore is done', () => {
    expect(
      isMobileShellLive({
        activeConnection: { connectionId: 'ssh-box' },
        gatewayState: 'open',
        hasConnected: false,
        restoring: false,
        switching: false
      })
    ).toBe(true)
  })

  it('stays on Connect while restoring even if a descriptor is already published', () => {
    expect(
      isMobileShellLive({
        activeConnection: { connectionId: 'ssh-box' },
        gatewayState: 'open',
        hasConnected: false,
        restoring: true,
        switching: false
      })
    ).toBe(false)
  })

  it('does not treat phase-less applyConnection success as live until the socket opens', () => {
    // selectConnection publishes $activeConnection before softSwitch dials.
    // Without the open socket the phone would leave Connect with a dead shell.
    expect(
      isMobileShellLive({
        activeConnection: { connectionId: 'ssh-box' },
        gatewayState: 'closed',
        hasConnected: false,
        restoring: false,
        switching: true
      })
    ).toBe(false)
  })

  it('keeps the shell mounted across an in-session soft switch once hasConnected latched', () => {
    expect(
      isMobileShellLive({
        activeConnection: { connectionId: 'ssh-box' },
        gatewayState: 'closed',
        hasConnected: true,
        restoring: false,
        switching: true
      })
    ).toBe(true)
  })

  it('keeps the shell mounted across a mid-session socket drop once hasConnected latched', () => {
    expect(
      isMobileShellLive({
        activeConnection: { connectionId: 'ssh-box' },
        gatewayState: 'closed',
        hasConnected: true,
        restoring: false,
        switching: false
      })
    ).toBe(true)
  })

  it('stays off the shell while restoring even after hasConnected', () => {
    expect(
      isMobileShellLive({
        activeConnection: { connectionId: 'ssh-box' },
        gatewayState: 'closed',
        hasConnected: true,
        restoring: true,
        switching: false
      })
    ).toBe(false)
  })

  it('keeps connecting while restoring with a published source and closed socket (cold dial)', () => {
    expect(
      isMobileShellLive({
        activeConnection: { connectionId: 'ssh-box' },
        gatewayState: 'closed',
        hasConnected: false,
        restoring: true,
        switching: false
      })
    ).toBe(false)
  })
})
