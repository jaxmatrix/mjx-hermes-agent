import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '@/gateway'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({}),
    $gatewayState: atom('idle')
  }
})

vi.mock('@/components/chat/vibe-hearts', () => ({ burstVibeHearts: vi.fn() }))
vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/completion-sound', () => ({ playCompletionSound: vi.fn() }))

import { $approvalModes, approvalModeForProfile } from '@/store/approval-mode'
import { routeGatewayEvent } from '@/store/event-router'
import { requestGateway } from '@/store/gateway'
import { $activeProfile } from '@/store/profiles'
import { $activeSessionKey, $sessionStates, ensureSessionSlice } from '@/store/session-state-types'

const event = (type: string, payload: Record<string, unknown>, sessionId = 's1'): GatewayEvent =>
  ({ type, session_id: sessionId, payload }) as GatewayEvent

/**
 * The 08-18 + 08-20 gateway sync (MJXHRM-443) turned two frames into
 * unsolicited mid-turn pushes. Both were reaching universal and dying: neither
 * the router's switch nor the reducer's had a case for `session.usage`, and
 * `session.info`'s two approval fields were read by nobody.
 *
 * Every fixture below seeds state that DISAGREES with the assertion, so a test
 * that passes because the reducer did nothing is impossible.
 */
describe('event-router → unsolicited session pushes', () => {
  beforeEach(() => {
    $sessionStates.set({})
    $activeSessionKey.set('s1')
    ensureSessionSlice('s1')
    $approvalModes.set({})
    // `$activeGatewayProfile` is COMPUTED over this one, so this is the only
    // way to move it — setting the computed is a silent no-op.
    $activeProfile.set('work')
  })

  const slice = (key = 's1') => $sessionStates.get()[key]

  describe('session.usage', () => {
    it('adopts a live tick mid-turn instead of dropping it', () => {
      // Turn-start values the client already has. The tick must replace them.
      $sessionStates.set({
        s1: { ...slice(), usage: { calls: 1, context_percent: 12, input: 100, output: 20, total: 120 } }
      })

      routeGatewayEvent(
        event('session.usage', {
          usage: { calls: 4, context_max: 200_000, context_percent: 41, context_used: 82_000, input: 900, output: 310 }
        })
      )

      expect(slice().usage).toMatchObject({
        calls: 4,
        context_max: 200_000,
        context_percent: 41,
        context_used: 82_000,
        input: 900,
        output: 310
      })
    })

    it('does not blank a painted gauge with a tick that omits the context fields', () => {
      // `_get_usage` populates context_* only from a REAL current-window
      // occupancy (#50421), so a tick during an external-context turn carries
      // counters and nothing else. Assigning would erase the meter.
      $sessionStates.set({
        s1: {
          ...slice(),
          usage: {
            calls: 1,
            context_max: 200_000,
            context_percent: 41,
            context_used: 82_000,
            input: 5,
            output: 5,
            total: 10
          }
        }
      })

      routeGatewayEvent(event('session.usage', { usage: { calls: 7, input: 950, output: 400, total: 1350 } }))

      expect(slice().usage).toMatchObject({ calls: 7, context_percent: 41, context_used: 82_000, total: 1350 })
    })

    it('ignores a frame whose usage is missing or not an object', () => {
      const before = { calls: 3, input: 1, output: 2, total: 3 }

      $sessionStates.set({ s1: { ...slice(), usage: before } })

      routeGatewayEvent(event('session.usage', {}))
      routeGatewayEvent(event('session.usage', { usage: 'nope' }))
      routeGatewayEvent(event('session.usage', { usage: [1, 2] }))

      expect(slice().usage).toBe(before)
    })

    it('folds a background tick into THAT session, not the visible one', () => {
      ensureSessionSlice('s2')
      $sessionStates.set({
        s1: { ...slice(), usage: { calls: 1, input: 0, output: 0, total: 0 } },
        s2: { ...slice('s2'), usage: null }
      })

      routeGatewayEvent(event('session.usage', { usage: { calls: 42 } }, 's2'))

      expect(slice('s2').usage).toMatchObject({ calls: 42 })
      expect(slice().usage).toMatchObject({ calls: 1 })
    })
  })

  it('does not let the end-of-turn settle zero the counters the ticks accumulated', async () => {
    // `session.context_breakdown` reports occupancy only — no calls, no
    // input/output — and the settle used to spread EMPTY_USAGE, so every
    // finished turn reset those three to 0 right after the ticks filled them.
    vi.mocked(requestGateway).mockResolvedValueOnce({
      context_max: 200_000,
      context_percent: 55,
      context_used: 110_000
    })
    $sessionStates.set({
      s1: { ...slice(), runtimeSessionId: 's1', usage: { calls: 9, input: 4200, output: 700, total: 4900 } }
    })

    routeGatewayEvent(event('message.complete', { text: 'done' }))
    await vi.waitFor(() => expect(slice().usage?.context_percent).toBe(55))

    expect(slice().usage).toMatchObject({ calls: 9, context_used: 110_000, input: 4200, output: 700 })
  })

  describe('session.info', () => {
    it('flips the approval indicator mid-turn', () => {
      // The cache says approvals are on; the gateway says they were turned off
      // from somewhere else. `broadcast_session_info()` is the only notice.
      $approvalModes.set({ work: 'smart' })

      routeGatewayEvent(event('session.info', { approval_mode: 'off', yolo: true }))

      expect(approvalModeForProfile('work')).toBe('off')
    })

    it('leaves the cache alone for a background session', () => {
      // s2 needs a SLICE, or the router fails closed on an unknown session and
      // the test passes without the active-session gate ever running.
      ensureSessionSlice('s2')
      $approvalModes.set({ work: 'smart' })

      routeGatewayEvent(event('session.info', { approval_mode: 'off' }, 's2'))

      expect(approvalModeForProfile('work')).toBe('smart')
      // …and the frame still reached the session that sent it.
      expect(slice('s2').yolo).toBe(false)
    })

    it('adopts the effective yolo flag onto the session slice', () => {
      $sessionStates.set({ s1: { ...slice(), yolo: false } })

      routeGatewayEvent(event('session.info', { yolo: true }))

      expect(slice().yolo).toBe(true)
    })

    it('adopts yolo:false back off again — false is a real state, not "unset"', () => {
      $sessionStates.set({ s1: { ...slice(), yolo: true } })

      routeGatewayEvent(event('session.info', { yolo: false }))

      expect(slice().yolo).toBe(false)
    })

    it('ignores a non-string approval_mode rather than normalizing it to manual', () => {
      $approvalModes.set({ work: 'smart' })

      routeGatewayEvent(event('session.info', { approval_mode: null }))

      expect(approvalModeForProfile('work')).toBe('smart')
    })
  })
})
