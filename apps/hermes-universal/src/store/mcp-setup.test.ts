import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({ status: 'ok' }),
    $gatewayState: atom('idle')
  }
})

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

vi.mock('@/store/pet', async importActual => {
  const actual = await importActual<typeof Pet>()

  return { ...actual, setPetActivity: vi.fn() }
})

import { requestGateway } from '@/store/gateway'
import { hasMcpSetupRequest, readMcpSetupAction, skipMcpSetupRequest } from '@/store/mcp-setup'
import { notifyError } from '@/store/notifications'
import type * as Pet from '@/store/pet'
import { setPetActivity } from '@/store/pet'
import { clearAllPrompts, sessionMcpSetupRequest, setSessionMcpSetup } from '@/store/prompts'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionKey, $sessionStates } from '@/store/session-state-types'

const rpc = vi.mocked(requestGateway)

const REQUEST = { action: 'install' as const, reason: 'To read the ticket', requestId: 'req-1', server: 'linear' }

beforeEach(() => {
  clearAllPrompts()
  resetServerRequestsForTests()
  $sessionStates.set({})
  $activeSessionKey.set('s1')
  rpc.mockReset()
  rpc.mockResolvedValue({ status: 'ok' })
  vi.mocked(notifyError).mockClear()
})

describe('readMcpSetupAction', () => {
  it('keeps the two non-default actions', () => {
    expect(readMcpSetupAction('enable')).toBe('enable')
    expect(readMcpSetupAction('authorize')).toBe('authorize')
  })

  // Seeded to disagree with a pass-through: the tool validates `action` on its
  // RETURN leg, so a value the schema never allowed still reaches the client,
  // and `install` is the only action safe to guess (it prompts for what it
  // needs, where a wrong `enable` flips a server the user never configured).
  it('falls back to install for anything else', () => {
    for (const value of ['Enable', 'obliterate', '', 7, null, undefined, { action: 'enable' }]) {
      expect(readMcpSetupAction(value)).toBe('install')
    }
  })
})

// The `readMcpSetupRequest` suite is GONE with the function (MJXHRM-520): the
// card's identity is the server request's own id now, and `McpSetupRequestParams`
// carries no `request_id` for a reader to find. The equivalent guard — a card
// with no server name is unrenderable and must be answered rather than shown —
// now lives on the router and is covered in `store/server-request-router.test.ts`.

describe('skipMcpSetupRequest', () => {
  /** Park a card whose server request is genuinely open, as the router does. */
  const park = (requestId = 'req-1') => {
    const respond = vi.fn()

    rememberServerRequest({ fail: vi.fn(), id: requestId, method: 'mcp.setup', params: {}, respond })
    setSessionMcpSetup('s1', { ...REQUEST, requestId })

    return respond
  }

  it('answers declined on the request the card was raised by', async () => {
    const respond = park()

    await expect(skipMcpSetupRequest('s1')).resolves.toBe(true)

    // `ValueResult`: the outcome is JSON under `value`. The retired
    // `mcp.setup.respond` used `result`, and sending the wrong key was a silent
    // no-answer worth ten minutes of a dead turn.
    expect(respond).toHaveBeenCalledWith({ value: JSON.stringify({ server: 'linear', status: 'declined' }) })
  })

  // `declined` and an empty answer are NOT interchangeable at the tool boundary:
  // empty is what a timeout produces, and the tool reports that as `unanswered`.
  it('never sends an empty result', async () => {
    const respond = park()

    await skipMcpSetupRequest('s1')

    const { value } = respond.mock.calls[0]![0] as { value: string }

    expect(JSON.parse(value).status).toBe('declined')
  })

  it('clears the card so a second Enter cannot answer twice', async () => {
    const respond = park()

    await skipMcpSetupRequest('s1')

    expect(sessionMcpSetupRequest('s1').get()).toBeNull()
    // The second skip finds nothing parked and must not reach the wire again.
    await skipMcpSetupRequest('s1')
    expect(respond).toHaveBeenCalledTimes(1)
  })

  // The pet's "waiting on you" pose is set by the request and, without this,
  // cleared only by `message.complete` — leaving it waiting for input nobody
  // will ever give for the rest of the turn. Same clear `respondClarify` does.
  it('drops the waiting pose it answered on behalf of', async () => {
    setSessionMcpSetup('s1', REQUEST)
    await skipMcpSetupRequest('s1')

    expect(setPetActivity).toHaveBeenCalledWith({ awaitingInput: false })
  })

  it('is a no-op with nothing parked', async () => {
    await expect(skipMcpSetupRequest('s1')).resolves.toBe(false)
    await expect(skipMcpSetupRequest(null)).resolves.toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })

  /**
   * MJXHRM-418 inverted by the request wire. The old skip could fail IN TRANSIT
   * — an RPC rejection — and had to put the card back, because the agent was
   * still parked for its ten minutes. A response frame cannot fail that way: the
   * only failure left is that nothing is open under that id, which means the
   * card was already withdrawn and the tool has already returned. Restoring it
   * THEN would leave an unanswerable card offering to install a server nothing
   * is waiting on, so it stays cleared and the user is told.
   */
  it('says so when the card had already been withdrawn, and does not put it back', async () => {
    setSessionMcpSetup('s1', REQUEST)

    await expect(skipMcpSetupRequest('s1')).resolves.toBe(true)

    expect(sessionMcpSetupRequest('s1').get()).toBeNull()
    expect(notifyError).toHaveBeenCalled()
  })
})

// The `applyResumedMcpSetup` suite is GONE with the function (MJXHRM-520). Its
// fixtures were all `pending_prompt` payloads, a field the merged backend no
// longer sends — so the suite proved only that dead code still behaved. A card
// still open after a reconnect now returns as an `open_requests` entry and is
// re-delivered to the request router, which is where its coverage lives.

describe('hasMcpSetupRequest', () => {
  it('reports what is parked on that session key only', () => {
    setSessionMcpSetup('s1', REQUEST)

    expect(hasMcpSetupRequest('s1')).toBe(true)
    expect(hasMcpSetupRequest('s2')).toBe(false)
    expect(hasMcpSetupRequest(null)).toBe(false)
    expect(hasMcpSetupRequest(undefined)).toBe(false)
  })
})
