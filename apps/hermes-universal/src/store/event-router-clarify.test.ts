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

import type { ToolCallPart } from '@/lib/chat-messages'
import { routeGatewayEvent } from '@/store/event-router'
import { clearAllPrompts, sessionClarifyRequest } from '@/store/prompts'
import { $activeSessionKey, $sessionStates } from '@/store/session-state-types'

const event = (type: string, payload: Record<string, unknown>): GatewayEvent =>
  ({ type, session_id: 's1', payload }) as GatewayEvent

/**
 * MJXHRM-362. The clarify tool RETURNING is its request's terminal event, and
 * the one signal every ending shares: the user answered, the backend's `_block`
 * timed out, or `session.interrupt` released it with `_clear_pending`. Only the
 * answered path cleared the request (`respondClarify`), so a timed-out or
 * interrupted clarify stayed "parked" until `message.complete` — and
 * `$activeSessionAwaitingInput` is what makes Esc decline to interrupt a turn
 * waiting on the user, so Esc was dead for the rest of that turn.
 */
describe('event-router → clarify lifecycle', () => {
  beforeEach(() => {
    clearAllPrompts()
    $sessionStates.set({})
    $activeSessionKey.set('s1')
  })

  const raise = () =>
    routeGatewayEvent(event('clarify.request', { request_id: 'req-1', question: 'Which branch?', choices: ['main'] }))

  it('parks the request the panel answers from', () => {
    raise()

    expect(sessionClarifyRequest('s1').get()).toEqual({
      requestId: 'req-1',
      question: 'Which branch?',
      choices: ['main']
    })
  })

  it('releases it when the clarify tool returns, however it ended', () => {
    raise()
    routeGatewayEvent(event('tool.complete', { name: 'clarify', tool_id: 'call_abc123', result: '' }))

    expect(sessionClarifyRequest('s1').get()).toBeNull()
  })

  it('leaves it parked while some other tool finishes', () => {
    raise()
    routeGatewayEvent(event('tool.complete', { name: 'bash', tool_id: 'call_x', result: 'ok' }))

    expect(sessionClarifyRequest('s1').get()?.requestId).toBe('req-1')
  })
})

const toolParts = (key: string): ToolCallPart[] =>
  ($sessionStates.get()[key]?.messages ?? []).flatMap(message =>
    message.parts.filter((part): part is ToolCallPart => part.type === 'tool-call')
  )

/**
 * MJXHRM-458. `tools/clarify_tool.py` can ask 2–5 questions in ONE
 * `clarify.request`, and that payload carries `questions[]` with no top-level
 * `question` at all. The router tested `requestId && question`, so the event
 * was dropped on the floor: no prompt store entry, no transcript row, nothing
 * that could ever call `clarify.respond` — and the agent stayed parked in the
 * backend's `_block` for the whole clarify deadline.
 */
describe('event-router → batch clarify', () => {
  beforeEach(() => {
    clearAllPrompts()
    $sessionStates.set({})
    $activeSessionKey.set('s1')
  })

  // Deliberately shaped like the wire: no `question`, no `choices`, only
  // `questions[]`. A fixture that also carried a top-level question would pass
  // against the OLD router too.
  const batch = () =>
    routeGatewayEvent(
      event('clarify.request', {
        request_id: 'req-batch',
        questions: [
          { qid: 'q0', question: 'Drink?', choices: ['Coffee', 'Tea'], multi_select: false },
          { qid: 'q1', question: 'Time?', choices: [], multi_select: true }
        ]
      })
    )

  it('parks a batch the card can answer', () => {
    batch()

    expect(sessionClarifyRequest('s1').get()).toEqual({
      requestId: 'req-batch',
      question: '',
      choices: null,
      questions: [
        { qid: 'q0', question: 'Drink?', choices: ['Coffee', 'Tea'], multiSelect: false },
        // No choices survived, so multi_select has nothing to multi-pick from.
        { qid: 'q1', question: 'Time?', choices: null, multiSelect: false }
      ],
      lockedAnswers: undefined
    })
  })

  // The synthetic row is what the card mounts on when `tool.start` was missed,
  // and its `questions` arg is the only value `lib/chat-tool-parts` can
  // correlate the two clarify rows on — a batch has no `question` to match.
  it('builds the transcript row a batch card mounts on', () => {
    batch()

    expect(toolParts('s1')).toEqual([
      expect.objectContaining({
        toolCallId: 'req-batch',
        toolName: 'clarify',
        args: {
          questions: [
            { qid: 'q0', question: 'Drink?' },
            { qid: 'q1', question: 'Time?' }
          ]
        }
      })
    ])
    expect($sessionStates.get().s1?.needsInput).toBe(true)
  })

  it('replays the answers the gateway already locked', () => {
    routeGatewayEvent(
      event('clarify.request', {
        request_id: 'req-batch',
        questions: [{ qid: 'q0', question: 'Drink?', choices: ['Coffee'] }],
        answers: { q0: 'Coffee', q9: 7 }
      })
    )

    // `q9` is not a string answer, so it is not one this card can stage back.
    expect(sessionClarifyRequest('s1').get()?.lockedAnswers).toEqual({ q0: 'Coffee' })
  })

  // A batch whose entries are all unusable is not a batch — falling through to
  // the single-question branch (which also has nothing) is right, and mounting
  // an unanswerable form is not.
  it('ignores a batch with no usable question', () => {
    routeGatewayEvent(
      event('clarify.request', { request_id: 'req-junk', questions: [{ question: 'no qid' }, { qid: 'q0' }, 7] })
    )

    expect(sessionClarifyRequest('s1').get()).toBeNull()
    expect(toolParts('s1')).toEqual([])
  })
})
