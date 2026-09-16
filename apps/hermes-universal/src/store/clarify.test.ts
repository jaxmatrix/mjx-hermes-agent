import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bareChoice,
  hasClarifyRequest,
  matchClarifyRequest,
  normalizeChoices,
  normalizeQuestions,
  readChoices,
  readLockedAnswers,
  RECOMMENDED_LABEL,
  skipClarifyRequest
} from '@/store/clarify'
import { clearAllPrompts, sessionClarifyRequest, setSessionClarify } from '@/store/prompts'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $sessionStates } from '@/store/session-state-types'

vi.mock('@/store/gateway', () => ({
  $gatewayState: { get: () => 'open', subscribe: () => () => {} },
  requestGateway: vi.fn(() => Promise.resolve({}))
}))

vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))

const { requestGateway } = await import('@/store/gateway')
const { notifyError } = await import('@/store/notifications')

beforeEach(() => {
  clearAllPrompts()
  resetServerRequestsForTests()
  $sessionStates.set({})
  vi.mocked(requestGateway).mockClear()
  vi.mocked(requestGateway).mockResolvedValue({})
  vi.mocked(notifyError).mockClear()
})

describe('normalizeChoices', () => {
  it('keeps ordinary options', () => {
    expect(normalizeChoices(['staging', 'prod'])).toEqual(['staging', 'prod'])
  })

  // A choice list comes out of a model's tool call. Each of these renders
  // badly and cannot be recovered from once on screen.
  it('drops blank, multi-line and over-long entries', () => {
    expect(normalizeChoices(['ok', '', '   ', 'two\nlines', 'x'.repeat(201)])).toEqual(['ok'])
  })

  it('drops non-strings and a non-array payload', () => {
    expect(normalizeChoices(['ok', 42, null, { a: 1 }])).toEqual(['ok'])
    expect(normalizeChoices('staging')).toEqual([])
    expect(normalizeChoices(undefined)).toEqual([])
  })

  it('keeps a choice exactly at the length limit', () => {
    expect(normalizeChoices(['x'.repeat(200)])).toHaveLength(1)
  })
})

describe('readChoices', () => {
  it('returns null rather than an empty list, so the panel falls back to free text', () => {
    expect(readChoices('gateway', 'q', [])).toBeNull()
    expect(readChoices('gateway', 'q', undefined)).toBeNull()
  })

  // Degrading silently to a free-text box looks identical to a question the
  // model never offered options for, so a malformed tool call would be invisible.
  it('warns when a non-empty payload normalized away to nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readChoices('tool_args', 'Which target?', ['', '  '])).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)

    warn.mockRestore()
  })

  it('does not warn when there were no choices to begin with', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    readChoices('gateway', 'Which target?', undefined)

    expect(warn).not.toHaveBeenCalled()

    warn.mockRestore()
  })
})

describe('skipClarifyRequest', () => {
  /** Park a clarify whose server request is genuinely open, as the router does. */
  const park = (requestId: string) => {
    const respond = vi.fn()

    rememberServerRequest({ fail: vi.fn(), id: requestId, method: 'clarify', params: {}, respond })
    setSessionClarify('s1', { choices: null, question: 'q', requestId })

    return respond
  }

  it('answers the request with the skip value and clears the card', async () => {
    const respond = park('req-1')

    expect(hasClarifyRequest('s1')).toBe(true)
    expect(await skipClarifyRequest('s1')).toBe(true)

    // '' is the clarify tool's own "skipped" answer. A response carrying NO
    // answer would mean cancel-all, which is a different instruction.
    expect(respond).toHaveBeenCalledWith({ answer: '' })
    expect(sessionClarifyRequest('s1').get()).toBeNull()
  })

  /**
   * MJXHRM-418 inverted by the request wire. The old skip could fail IN TRANSIT
   * — an RPC rejection — and the card had to come back, because the agent was
   * still parked. A response frame cannot fail that way: the only failure left
   * is that nothing is open under that id, which means the question was already
   * withdrawn and the agent has moved on. Putting the card back THEN would
   * strand an unanswerable prompt on screen, so it stays cleared and the user is
   * told instead.
   */
  it('says so when the question had already been withdrawn, and does not put it back', async () => {
    setSessionClarify('s1', { choices: null, question: 'q', requestId: 'never-opened' })

    expect(await skipClarifyRequest('s1')).toBe(true)
    expect(notifyError).toHaveBeenCalled()
    expect(sessionClarifyRequest('s1').get()).toBeNull()
  })

  it('is a no-op with nothing parked', async () => {
    expect(await skipClarifyRequest('s1')).toBe(false)
    expect(await skipClarifyRequest(null)).toBe(false)
    expect(notifyError).not.toHaveBeenCalled()
  })
})

describe('matchClarifyRequest', () => {
  const request = { requestId: 'req-1', question: 'Which branch?', choices: null }

  it('matches when the row carries no question of its own', () => {
    expect(matchClarifyRequest(request, '')).toBe(request)
  })

  it('matches the row asking the same question', () => {
    expect(matchClarifyRequest(request, 'Which branch?')).toBe(request)
  })

  // An old clarify row whose `tool.complete` was lost must not offer to answer
  // the NEW question parked on the session.
  it('rejects a row asking a different question', () => {
    expect(matchClarifyRequest(request, 'Which region?')).toBeNull()
  })

  it('is null with nothing parked', () => {
    expect(matchClarifyRequest(null, 'Which branch?')).toBeNull()
    expect(matchClarifyRequest(undefined, '')).toBeNull()
  })
})

// The `applyResumedClarify` suite lived here and is GONE with the function
// (MJXHRM-520). Every case in it fed a `pending_prompt` the merged backend no
// longer sends, so the suite could only ever have proved that dead code still
// behaved — the defect it was written for (MJXHRM-362) is now handled by
// `open_requests` re-delivery through the request router, and is covered by
// `store/server-request-router.test.ts` against a REPLAYED request instead.

/**
 * MJXHRM-458. There is no `recommended` field on the wire: the backend appends
 * "(Recommended)" to the FIRST choice string (`mark_recommended`) and strips it
 * back off the answer (`strip_recommended`). So the label arrives inside the
 * data the renderer measures and displays.
 */
describe('recommended-choice labelling', () => {
  it('reads the option without the label the backend appended', () => {
    expect(bareChoice(`Rebase onto main ${RECOMMENDED_LABEL}`)).toBe('Rebase onto main')
    // No label — the string is the option, trailing spaces and all.
    expect(bareChoice('Rebase onto main')).toBe('Rebase onto main')
  })

  // The label is 14 characters the model did not write. Measuring the decorated
  // string dropped an option that was inside the limit as offered — and a
  // dropped first choice is exactly the recommended one.
  it('does not drop a choice for length the label added', () => {
    const atLimit = 'x'.repeat(200)

    expect(normalizeChoices([`${atLimit} ${RECOMMENDED_LABEL}`])).toEqual([`${atLimit} ${RECOMMENDED_LABEL}`])
    expect(normalizeChoices([`${'x'.repeat(201)} ${RECOMMENDED_LABEL}`])).toEqual([])
  })
})

describe('normalizeQuestions', () => {
  it('keeps the questions a card can actually answer', () => {
    expect(
      normalizeQuestions([
        { qid: ' q0 ', question: ' Drink? ', choices: ['Coffee', '', 'line\nbreak'], multi_select: true },
        { qid: 'q1', question: 'Open?', choices: null }
      ])
    ).toEqual([
      { qid: 'q0', question: 'Drink?', choices: ['Coffee'], multiSelect: true },
      { qid: 'q1', question: 'Open?', choices: null, multiSelect: false }
    ])
  })

  // A qid-less entry can never be locked — `clarify.respond` answers 4002 to
  // anything that is not one of the batch's own qids — so rendering it offers
  // the user an answer the gateway will refuse.
  it('drops entries that could never be answered', () => {
    expect(
      normalizeQuestions([{ question: 'no qid' }, { qid: 'q0' }, { qid: 'q1', question: '  ' }, 'nope', null])
    ).toEqual([])
    expect(normalizeQuestions('not an array')).toEqual([])
  })

  // multi_select with nothing to multi-pick from is a free-text question.
  it('only honors multi_select alongside surviving choices', () => {
    expect(normalizeQuestions([{ qid: 'q0', question: 'Q?', choices: ['   '], multi_select: true }])).toEqual([
      { qid: 'q0', question: 'Q?', choices: null, multiSelect: false }
    ])
  })
})

describe('readLockedAnswers', () => {
  it('keeps only the answers a card can stage back', () => {
    expect(readLockedAnswers({ q0: 'Coffee', q1: 7, q2: null })).toEqual({ q0: 'Coffee' })
  })

  it('reports nothing locked as undefined, not an empty map', () => {
    expect(readLockedAnswers({})).toBeUndefined()
    expect(readLockedAnswers({ q0: 7 })).toBeUndefined()
    expect(readLockedAnswers(null)).toBeUndefined()
  })
})

// The batch arm of the same retired suite (MJXHRM-520). The property it
// protected — a batch coming back with the answers the server had already
// locked — is preserved: `lockedAnswers` is still read, from `params.answers`
// on a REPLAYED clarify request, and is covered against that wire in
// `store/server-request-router.test.ts`.
