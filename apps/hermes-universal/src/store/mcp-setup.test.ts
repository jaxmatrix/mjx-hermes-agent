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

import type { ToolCallPart } from '@/lib/chat-messages'
import { requestGateway } from '@/store/gateway'
import {
  applyResumedMcpSetup,
  hasMcpSetupRequest,
  readMcpSetupAction,
  readMcpSetupRequest,
  skipMcpSetupRequest
} from '@/store/mcp-setup'
import { notifyError } from '@/store/notifications'
import { clearAllPrompts, sessionMcpSetupRequest, setSessionMcpSetup } from '@/store/prompts'
import { $activeSessionKey, $sessionStates } from '@/store/session-state-types'
import type { SessionResumeResponse } from '@/types/hermes'

const rpc = vi.mocked(requestGateway)

const REQUEST = { action: 'install' as const, reason: 'To read the ticket', requestId: 'req-1', server: 'linear' }

const toolParts = (key: string): ToolCallPart[] =>
  ($sessionStates.get()[key]?.messages ?? []).flatMap(message =>
    message.parts.filter((part): part is ToolCallPart => part.type === 'tool-call')
  )

beforeEach(() => {
  clearAllPrompts()
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

describe('readMcpSetupRequest', () => {
  it('reads the wire payload the gateway emits', () => {
    expect(readMcpSetupRequest({ action: 'authorize', reason: 'why', request_id: 'req-1', server: 'linear' })).toEqual({
      action: 'authorize',
      reason: 'why',
      requestId: 'req-1',
      server: 'linear'
    })
  })

  it('tolerates a missing reason — the agent need not give one', () => {
    expect(readMcpSetupRequest({ request_id: 'req-1', server: 'linear' })).toEqual({
      action: 'install',
      reason: '',
      requestId: 'req-1',
      server: 'linear'
    })
  })

  it('refuses a payload nothing could answer or name', () => {
    expect(readMcpSetupRequest({ server: 'linear' })).toBeNull()
    expect(readMcpSetupRequest({ request_id: 'req-1' })).toBeNull()
    expect(readMcpSetupRequest({ request_id: 'req-1', server: '   ' })).toBeNull()
  })
})

describe('skipMcpSetupRequest', () => {
  it('answers declined with the request id of the card that raised it', async () => {
    setSessionMcpSetup('s1', REQUEST)

    await expect(skipMcpSetupRequest('s1')).resolves.toBe(true)

    expect(rpc).toHaveBeenCalledWith('mcp.setup.respond', {
      request_id: 'req-1',
      result: JSON.stringify({ server: 'linear', status: 'declined' })
    })
  })

  // `declined` and an empty answer are NOT interchangeable at the tool boundary:
  // empty is what a timeout produces, and the tool reports that as `unanswered`.
  it('never sends an empty result', async () => {
    setSessionMcpSetup('s1', REQUEST)
    await skipMcpSetupRequest('s1')

    const [, params] = rpc.mock.calls[0]!

    expect(JSON.parse(String((params as { result: string }).result)).status).toBe('declined')
  })

  it('clears the card before the RPC settles so a second Enter cannot answer twice', async () => {
    setSessionMcpSetup('s1', REQUEST)

    let release = () => {}
    rpc.mockImplementation(() => new Promise(resolve => (release = () => resolve({ status: 'ok' }))))

    const pending = skipMcpSetupRequest('s1')

    expect(sessionMcpSetupRequest('s1').get()).toBeNull()

    release()
    await pending
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('is a no-op with nothing parked', async () => {
    await expect(skipMcpSetupRequest('s1')).resolves.toBe(false)
    await expect(skipMcpSetupRequest(null)).resolves.toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })

  // MJXHRM-418: with the card torn down nothing else could ever answer, and
  // "the tool times out on its own" costs ten minutes of a dead turn.
  it('puts the card back and says so when the skip does not land', async () => {
    setSessionMcpSetup('s1', REQUEST)
    rpc.mockRejectedValue(new Error('socket closed'))

    await expect(skipMcpSetupRequest('s1')).resolves.toBe(true)

    expect(sessionMcpSetupRequest('s1').get()).toEqual(REQUEST)
    expect(notifyError).toHaveBeenCalled()
  })

  // Restoring over a fresh request would make THAT one unanswerable.
  it('does not restore over a request that arrived meanwhile', async () => {
    setSessionMcpSetup('s1', REQUEST)
    rpc.mockImplementation(async () => {
      setSessionMcpSetup('s1', { ...REQUEST, requestId: 'req-2', server: 'notion' })

      throw new Error('socket closed')
    })

    await skipMcpSetupRequest('s1')

    expect(sessionMcpSetupRequest('s1').get()?.requestId).toBe('req-2')
  })
})

describe('applyResumedMcpSetup', () => {
  const resumed = (pending: unknown): Pick<SessionResumeResponse, 'pending_prompt'> =>
    ({ pending_prompt: pending }) as Pick<SessionResumeResponse, 'pending_prompt'>

  it('rebuilds both halves of a card the cold open never saw', () => {
    applyResumedMcpSetup(
      's1',
      resumed({
        event: 'mcp.setup.request',
        payload: { action: 'install', reason: 'why', request_id: 'req-1', server: 'linear' }
      })
    )

    expect(sessionMcpSetupRequest('s1').get()?.requestId).toBe('req-1')
    expect(toolParts('s1')).toEqual([expect.objectContaining({ toolCallId: 'req-1', toolName: 'setup_mcp' })])
  })

  // The replay is an upsert: a card that survived the disconnect stays ONE card,
  // not two Install buttons answering the same blocking request.
  it('is idempotent', () => {
    const payload = { action: 'install', reason: 'why', request_id: 'req-1', server: 'linear' }

    applyResumedMcpSetup('s1', resumed({ event: 'mcp.setup.request', payload }))
    applyResumedMcpSetup('s1', resumed({ event: 'mcp.setup.request', payload }))

    expect(toolParts('s1')).toHaveLength(1)
  })

  // `pending_prompt` is generic across every blocking bridge, so the event name
  // is the only thing separating a parked clarify from a parked setup card.
  it('ignores a prompt that is not an mcp setup', () => {
    applyResumedMcpSetup(
      's1',
      resumed({ event: 'clarify.request', payload: { request_id: 'req-1', question: 'Which branch?' } })
    )
    applyResumedMcpSetup('s1', resumed(null))

    expect(sessionMcpSetupRequest('s1').get()).toBeNull()
    expect(toolParts('s1')).toEqual([])
  })

  it('ignores a parked prompt nothing could answer', () => {
    applyResumedMcpSetup('s1', resumed({ event: 'mcp.setup.request', payload: { server: 'linear' } }))

    expect(sessionMcpSetupRequest('s1').get()).toBeNull()
    expect(toolParts('s1')).toEqual([])
  })
})

describe('hasMcpSetupRequest', () => {
  it('reports what is parked on that session key only', () => {
    setSessionMcpSetup('s1', REQUEST)

    expect(hasMcpSetupRequest('s1')).toBe(true)
    expect(hasMcpSetupRequest('s2')).toBe(false)
    expect(hasMcpSetupRequest(null)).toBe(false)
    expect(hasMcpSetupRequest(undefined)).toBe(false)
  })
})
