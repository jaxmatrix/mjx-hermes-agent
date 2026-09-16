/**
 * The router that answers the backend's questions (MJXHRM-520).
 *
 * Every case here is about an agent thread parked in `server_requests.send()`.
 * The defect this unit fixes was silent: universal's forked client looked an
 * `srq-…` id up in its pending-CALL map, found nothing, and returned — so the
 * prompt never rendered and the turn sat until its deadline. So the assertions
 * are deliberately about the WIRE (what went back, under which id) and about
 * the decline path, not about "a store got written".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServerRequest, ServerRequestParams } from '@/gateway'

const notifications = vi.hoisted(() => ({ dispatch: vi.fn() }))

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    addServerRequestHandler: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({})
  }
})

vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: notifications.dispatch }))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }))
vi.mock('@/app/right-pane/terminal/buffer', () => ({ readActiveTerminal: () => null }))

import {
  clearAllPrompts,
  sessionApprovalRequest,
  sessionClarifyRequest,
  sessionMcpSetupRequest,
  sessionSudoRequest
} from '@/store/prompts'
import { handleRequestCancel, handleServerRequest } from '@/store/server-request-router'
import { resetServerRequestsForTests, respondToServerRequest } from '@/store/server-requests'
import { $activeSessionKey, $sessionStates } from '@/store/session-state-types'

/** A server request with spies for the two ways it can be settled. */
function makeRequest(method: string, params: ServerRequestParams = {}, id = `srq-${method}`) {
  const respond = vi.fn()
  const fail = vi.fn()
  const request: ServerRequest = { fail, id, method, params, respond }

  return { fail, request, respond }
}

beforeEach(() => {
  clearAllPrompts()
  resetServerRequestsForTests()
  $sessionStates.set({})
  $activeSessionKey.set('s1')
  notifications.dispatch.mockClear()
})

describe('clarify', () => {
  /**
   * T1 — the defect itself. A `clarify` request must open the card AND the
   * user's answer must go back as a response on THAT id. Asserting the id is
   * the point: the old client dropped the frame precisely because it could not
   * correlate it.
   */
  it('opens the card and answers on the request’s own id', () => {
    const { request, respond } = makeRequest('clarify', {
      choices: ['main', 'dev'],
      question: 'Which branch?',
      session_id: 's1'
    })

    expect(handleServerRequest(request)).toBe(true)
    expect(sessionClarifyRequest('s1').get()).toMatchObject({
      choices: ['main', 'dev'],
      question: 'Which branch?',
      requestId: 'srq-clarify'
    })

    expect(respondToServerRequest('srq-clarify', { answer: 'dev' })).toBe(true)
    expect(respond).toHaveBeenCalledWith({ answer: 'dev' })
  })

  // Seeded to disagree with "just park whatever arrives": a request with no
  // question and no questions is unanswerable by the user, so it is answered
  // immediately with the tool's own "skipped" value rather than left open.
  it('skips a request with nothing renderable instead of parking a dead card', () => {
    const { request, respond } = makeRequest('clarify', { session_id: 's1' })

    handleServerRequest(request)

    expect(respond).toHaveBeenCalledWith({ answer: '' })
    expect(sessionClarifyRequest('s1').get()).toBeNull()
  })

  // A batch carries `questions[]` and no top-level question, and on a REPLAY it
  // also carries the answers the server already locked.
  it('rebuilds a replayed batch with the answers already locked', () => {
    const { request } = makeRequest('clarify', {
      answers: { q0: 'Tea' },
      questions: [
        { qid: 'q0', question: 'Drink?', choices: ['Coffee', 'Tea'] },
        { qid: 'q1', question: 'Time?', choices: ['Morning'] }
      ],
      session_id: 's1'
    })

    request.replayed = true
    handleServerRequest(request)

    expect(sessionClarifyRequest('s1').get()).toMatchObject({
      lockedAnswers: { q0: 'Tea' },
      question: '',
      requestId: 'srq-clarify'
    })
  })

  /**
   * T4 — a replayed request must not re-notify. The card is already on screen
   * after a reconnect; buzzing the user again for a question they are looking
   * at is the regression this guards.
   */
  it('notifies for a live request and stays silent for a replayed one', () => {
    handleServerRequest(makeRequest('clarify', { question: 'Live?', session_id: 's1' }, 'srq-live').request)
    expect(notifications.dispatch).toHaveBeenCalledTimes(1)

    const replayed = makeRequest('clarify', { question: 'Replayed?', session_id: 's1' }, 'srq-replayed').request

    replayed.replayed = true
    handleServerRequest(replayed)

    expect(notifications.dispatch).toHaveBeenCalledTimes(1)
  })
})

describe('sudo and secret', () => {
  // `ValueResult` — the credential rides back under `value`, and nothing else.
  it('answers sudo under value', () => {
    const { request, respond } = makeRequest('sudo', { session_id: 's1' })

    handleServerRequest(request)

    expect(sessionSudoRequest('s1').get()).toEqual({ requestId: 'srq-sudo' })
    respondToServerRequest('srq-sudo', { value: 'hunter2' })
    expect(respond).toHaveBeenCalledWith({ value: 'hunter2' })
  })
})

describe('mcp.setup', () => {
  it('parks the card under the request id', () => {
    const { request } = makeRequest('mcp.setup', { reason: 'To read the ticket', server: 'linear', session_id: 's1' })

    handleServerRequest(request)

    expect(sessionMcpSetupRequest('s1').get()).toMatchObject({
      action: 'install',
      requestId: 'srq-mcp.setup',
      server: 'linear'
    })
  })

  // Without a server name the card would ask the user to consent to installing
  // "" — answer it rather than render something unanswerable.
  it('answers empty when the request names no server', () => {
    const { request, respond } = makeRequest('mcp.setup', { session_id: 's1' })

    handleServerRequest(request)

    expect(respond).toHaveBeenCalledWith({ value: '' })
    expect(sessionMcpSetupRequest('s1').get()).toBeNull()
  })
})

describe('approval', () => {
  /**
   * T10 / correction C1. A LIVE approval arrives as a request and carries TWO
   * ids: the approval queue's own `request_id` (what `approval.respond` keys
   * on) and the server request's id (what the card answers over). Losing either
   * one answers the wrong queue entry or nothing at all.
   */
  it('keeps both the queue id and the server-request id', () => {
    const { request } = makeRequest('approval', {
      command: 'rm -rf /',
      request_id: 'appr-7',
      session_id: 's1'
    })

    handleServerRequest(request)

    expect(sessionApprovalRequest('s1').get()).toMatchObject({
      command: 'rm -rf /',
      requestId: 'appr-7',
      serverRequestId: 'srq-approval'
    })
  })
})

describe('methods universal cannot answer', () => {
  /**
   * T2 — the vault trio is DECLINED, not answered. Returning false is what makes
   * the channel send -32601 in the same tick, so the tool fails fast instead of
   * waiting out its deadline against a client with no vault UI (MJXHRM-522).
   */
  it('declines every vault method', () => {
    for (const method of ['vault.code', 'vault.save_login', 'vault.unlock_prompt']) {
      const { request, respond } = makeRequest(method, { session_id: 's1' })

      expect(handleServerRequest(request), `${method} must be declined`).toBe(false)
      // Declining means NOT answering: the channel owns the error frame.
      expect(respond).not.toHaveBeenCalled()
    }
  })

  it('declines a method the contract may add later', () => {
    expect(handleServerRequest(makeRequest('something.new', { session_id: 's1' }).request)).toBe(false)
  })
})

describe('request.cancel', () => {
  /**
   * T3 — the cancel is correlated on the ID alone. A session can hold two
   * prompts at once, and a cancel that arrives late for the older one must not
   * erase the newer one the user is now looking at.
   */
  it('clears only the card that holds the cancelled id', () => {
    handleServerRequest(makeRequest('clarify', { question: 'Older?', session_id: 's1' }, 'srq-old').request)
    handleServerRequest(makeRequest('sudo', { session_id: 's1' }, 'srq-new').request)

    expect(sessionClarifyRequest('s1').get()?.requestId).toBe('srq-old')
    expect(sessionSudoRequest('s1').get()?.requestId).toBe('srq-new')

    handleRequestCancel({ payload: { id: 'srq-old', method: 'clarify', reason: 'timeout' }, type: 'request.cancel' })

    expect(sessionClarifyRequest('s1').get()).toBeNull()
    // The newer prompt survives — this is the whole point of id correlation.
    expect(sessionSudoRequest('s1').get()?.requestId).toBe('srq-new')
  })

  it('drops the cancelled request so a late answer cannot go out', () => {
    handleServerRequest(makeRequest('clarify', { question: 'Which?', session_id: 's1' }, 'srq-x').request)
    handleRequestCancel({ payload: { id: 'srq-x', method: 'clarify', reason: 'interrupt' }, type: 'request.cancel' })

    expect(respondToServerRequest('srq-x', { answer: 'too late' })).toBe(false)
  })

  it('ignores an unrelated event and a cancel with no id', () => {
    handleServerRequest(makeRequest('clarify', { question: 'Which?', session_id: 's1' }, 'srq-keep').request)
    handleRequestCancel({ payload: { id: '' }, type: 'request.cancel' })
    handleRequestCancel({ payload: { id: 'srq-keep' }, type: 'message.delta' })

    expect(sessionClarifyRequest('s1').get()?.requestId).toBe('srq-keep')
  })
})

describe('answering twice', () => {
  /**
   * T11. A double-tap must not put two response frames on the wire: the first
   * answer wins and the second is a local no-op. (The shared channel and the
   * backend each drop it too — this is the first of three defences.)
   */
  it('sends nothing on the second answer', () => {
    const { request, respond } = makeRequest('clarify', { question: 'Which?', session_id: 's1' })

    handleServerRequest(request)

    expect(respondToServerRequest('srq-clarify', { answer: 'first' })).toBe(true)
    expect(respondToServerRequest('srq-clarify', { answer: 'second' })).toBe(false)
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith({ answer: 'first' })
  })
})
