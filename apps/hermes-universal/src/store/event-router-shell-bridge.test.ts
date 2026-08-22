/**
 * The router half of `pane.reveal` / `layout.apply` (MJXHRM-472).
 *
 * `store/pane-focus.test.ts` covers the mapping; this covers the GATE. Desktop
 * runs both handlers behind `isActiveEvent` — "offer, don't hijack" — and
 * universal's equivalent is the router's `isActive`. The failure this pins is
 * the one nobody would notice in a single-session demo: a BACKGROUND turn
 * rearranging the window of the chat the user is actually reading.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '@/gateway'

const bridge = vi.hoisted(() => ({
  applyBridgeLayoutPreset: vi.fn(),
  revealBridgePane: vi.fn()
}))

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('idle'),
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({})
  }
})

vi.mock('@/store/pane-focus', () => bridge)
vi.mock('@/components/chat/vibe-hearts', () => ({ burstVibeHearts: vi.fn() }))
vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/completion-sound', () => ({ playCompletionSound: vi.fn() }))

import { routeGatewayEvent } from '@/store/event-router'
import { $activeSessionKey, $sessionStates, ensureSessionSlice } from '@/store/session-state-types'

const event = (type: string, payload: Record<string, unknown>, sessionId: string): GatewayEvent =>
  ({ payload, session_id: sessionId, type }) as GatewayEvent

describe('event-router → shell bridge', () => {
  beforeEach(() => {
    $sessionStates.set({})
    // The chat the user is looking at, and one running in the background. Both
    // are known sessions: the router fails closed on an unknown one, which
    // would make the gate below pass for the wrong reason.
    $activeSessionKey.set('visible')
    ensureSessionSlice('visible')
    ensureSessionSlice('background')
    bridge.revealBridgePane.mockClear()
    bridge.applyBridgeLayoutPreset.mockClear()
  })

  it('reveals the pane the active session asked for', () => {
    routeGatewayEvent(event('pane.reveal', { pane: 'terminal' }, 'visible'))

    expect(bridge.revealBridgePane).toHaveBeenCalledWith('terminal')
  })

  it('applies the preset the active session asked for', () => {
    routeGatewayEvent(event('layout.apply', { preset: 'focus' }, 'visible'))

    expect(bridge.applyBridgeLayoutPreset).toHaveBeenCalledWith('focus')
  })

  it('ignores a BACKGROUND session moving the user’s focus', () => {
    routeGatewayEvent(event('pane.reveal', { pane: 'terminal' }, 'background'))
    routeGatewayEvent(event('layout.apply', { preset: 'focus' }, 'background'))

    expect(bridge.revealBridgePane).not.toHaveBeenCalled()
    expect(bridge.applyBridgeLayoutPreset).not.toHaveBeenCalled()
  })

  // A malformed frame must reach the mapper as an empty string, not as
  // `undefined` cast to one — the mapper's own rejection is what tells the
  // difference between "unknown pane" and "no pane field at all".
  it('normalises a non-string pane/preset to empty rather than passing it through', () => {
    routeGatewayEvent(event('pane.reveal', { pane: 42 }, 'visible'))
    routeGatewayEvent(event('layout.apply', {}, 'visible'))

    expect(bridge.revealBridgePane).toHaveBeenCalledWith('')
    expect(bridge.applyBridgeLayoutPreset).toHaveBeenCalledWith('')
  })
})
