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

import { routeGatewayEvent } from '@/store/event-router'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $activeSessionKey, $sessionStates, ensureSessionSlice } from '@/store/session-state-types'

const event = (payload: Record<string, unknown>, sessionId = 's1'): GatewayEvent =>
  ({ type: 'status.update', session_id: sessionId, payload }) as GatewayEvent

/**
 * `AIAgent._emit_warning` (`run_agent.py`) reaches the client as
 * `status.update{kind:'warn'}` — `_status_update` in `tui_gateway/server.py` is
 * the only builder and it stamps the producer's kind verbatim.
 *
 * The whole family used to be folded into `statusLine` with the agent's ordinary
 * narration and overwritten by the next frame, which is why the actionable half
 * of each one ("use /compact", "send it again") never survived to be read.
 *
 * The fixtures below are the REAL messages the backend emits, and every case
 * seeds a state that disagrees with its assertion.
 */
const OVERFLOW_WARNING =
  '⚠️ Session context (~462,118 tokens) exceeds the model context window (~200,000 tokens) with compression ' +
  'disabled (compression.enabled: false). Use /compact to compress history or enable compression in config.yaml.'

const LEASE_TIMEOUT_WARNING =
  '⏳ Another Hermes process kept this session busy too long. Your message was not processed - wait for the ' +
  'other process to finish, then send it again.'

describe('event-router → agent warnings', () => {
  beforeEach(() => {
    $sessionStates.set({})
    $activeSessionKey.set('s1')
    ensureSessionSlice('s1')
    ensureSessionSlice('background')
    clearNotifications()
  })

  it('raises the mid-turn uncompressed-overflow guardrail as a toast instead of dropping it', () => {
    routeGatewayEvent(event({ kind: 'warn', text: OVERFLOW_WARNING }))

    const [toast] = $notifications.get()

    expect(toast?.message).toBe(OVERFLOW_WARNING)
    expect(toast?.kind).toBe('warning')
  })

  it('leaves the warning sticky — a warning toast has no auto-dismiss timer', () => {
    vi.useFakeTimers()

    try {
      routeGatewayEvent(event({ kind: 'warn', text: OVERFLOW_WARNING }))
      // Longer than every non-warning kind's 5s default. The point of the
      // dedup on the producing side is that the user reads this one.
      vi.advanceTimersByTime(120_000)

      expect($notifications.get()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a BACKGROUND session warning — the one the user cannot see for themselves', () => {
    // Active session is 's1'; the warning belongs to another one. Presentation
    // below the `isActive` gate would drop this.
    routeGatewayEvent(event({ kind: 'warn', text: LEASE_TIMEOUT_WARNING }, 'background'))

    expect($notifications.get()[0]?.message).toBe(LEASE_TIMEOUT_WARNING)
  })

  it('replaces an earlier warning for the same session in place rather than stacking', () => {
    routeGatewayEvent(event({ kind: 'warn', text: OVERFLOW_WARNING }))
    routeGatewayEvent(event({ kind: 'warn', text: LEASE_TIMEOUT_WARNING }))

    expect($notifications.get()).toHaveLength(1)
    expect($notifications.get()[0]?.message).toBe(LEASE_TIMEOUT_WARNING)
  })

  it('keeps the warnings of two different sessions apart', () => {
    routeGatewayEvent(event({ kind: 'warn', text: OVERFLOW_WARNING }))
    routeGatewayEvent(event({ kind: 'warn', text: LEASE_TIMEOUT_WARNING }, 'background'))

    expect(
      $notifications
        .get()
        .map(entry => entry.message)
        .sort()
    ).toEqual([LEASE_TIMEOUT_WARNING, OVERFLOW_WARNING].sort())
  })

  it('does NOT toast ordinary narration', () => {
    // Every one of these is a `status.update` too. Toasting them would put a
    // sticky, undismissable-by-timer card on screen for every compaction.
    routeGatewayEvent(event({ kind: 'compacting', text: '🗜️ Compacting context…' }))
    routeGatewayEvent(event({ kind: 'status', text: 'thinking...' }))
    routeGatewayEvent(event({ kind: 'lifecycle', text: 'Turn started' }))
    routeGatewayEvent(event({ kind: 'goal', text: 'ship the banner' }))

    expect($notifications.get()).toEqual([])
  })

  it('drops a warn frame with no text rather than toasting an empty card', () => {
    routeGatewayEvent(event({ kind: 'warn', text: '   ' }))

    expect($notifications.get()).toEqual([])
  })

  it('still folds the warning into the status line — the toast is additive', () => {
    // Seed a line that disagrees, so "unchanged" cannot pass this.
    routeGatewayEvent(event({ kind: 'status', text: 'thinking...' }))
    routeGatewayEvent(event({ kind: 'warn', text: OVERFLOW_WARNING }))

    expect($sessionStates.get().s1?.statusLine).toBe(OVERFLOW_WARNING)
  })
})
