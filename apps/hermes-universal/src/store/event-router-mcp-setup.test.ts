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
import { clearAllPrompts, sessionAwaitingInput, sessionMcpSetupRequest } from '@/store/prompts'
import { $activeSessionKey, $sessionStates } from '@/store/session-state-types'

const event = (type: string, payload: Record<string, unknown>, sessionId = 's1'): GatewayEvent =>
  ({ type, session_id: sessionId, payload }) as GatewayEvent

const toolParts = (key: string): ToolCallPart[] =>
  ($sessionStates.get()[key]?.messages ?? []).flatMap(message =>
    message.parts.filter((part): part is ToolCallPart => part.type === 'tool-call')
  )

/**
 * MJXHRM-451. `setup_mcp` rides the same `_block` bridge as clarify but with a
 * TEN-minute budget (`tui_gateway/server.py`, `timeout=600`), and an unanswered
 * card is reported to the model as `unanswered`, not `declined`. Every frame in
 * its lifecycle — request, expire, the tool returning — has to land here, or the
 * agent spends ten minutes parked with nothing on screen to answer.
 */
describe('event-router → mcp.setup lifecycle', () => {
  beforeEach(() => {
    clearAllPrompts()
    $sessionStates.set({})
    $activeSessionKey.set('s1')
  })

  const raise = (payload: Record<string, unknown> = {}, sessionId = 's1') =>
    routeGatewayEvent(
      event(
        'mcp.setup.request',
        { request_id: 'req-1', server: 'linear', action: 'install', reason: 'To read the ticket', ...payload },
        sessionId
      )
    )

  it('parks the request the card answers from', () => {
    raise()

    expect(sessionMcpSetupRequest('s1').get()).toEqual({
      requestId: 'req-1',
      server: 'linear',
      action: 'install',
      reason: 'To read the ticket'
    })
  })

  it('builds the transcript row the card mounts on, correlated by server', () => {
    raise()

    expect(toolParts('s1')).toEqual([
      expect.objectContaining({
        toolCallId: 'req-1',
        toolName: 'setup_mcp',
        args: { action: 'install', reason: 'To read the ticket', server: 'linear' }
      })
    ])
    expect($sessionStates.get().s1?.needsInput).toBe(true)
  })

  // The tool's own default. A payload whose action the schema never allowed
  // still reaches the client, because the tool validates on the RETURN leg.
  it('coerces an action outside the closed set to install', () => {
    raise({ action: 'obliterate' })

    expect(sessionMcpSetupRequest('s1').get()?.action).toBe('install')
  })

  it('keeps enable and authorize', () => {
    raise({ action: 'enable' })
    expect(sessionMcpSetupRequest('s1').get()?.action).toBe('enable')

    raise({ request_id: 'req-2', action: 'authorize' })
    expect(sessionMcpSetupRequest('s1').get()?.action).toBe('authorize')
  })

  // Seeded to DISAGREE with "render it anyway": a card that cannot be answered
  // is worse than no card, and the row must not appear either.
  it('ignores a frame with no request id', () => {
    raise({ request_id: '' })

    expect(sessionMcpSetupRequest('s1').get()).toBeNull()
    expect(toolParts('s1')).toEqual([])
  })

  it('ignores a frame with no server name', () => {
    raise({ server: '' })

    expect(sessionMcpSetupRequest('s1').get()).toBeNull()
    expect(toolParts('s1')).toEqual([])
  })

  // `coerceText` only coerces — whitespace is truthy. Store and row must agree
  // on rejecting it, or one half renders a card offering to install "   ".
  it('ignores a whitespace-only server name, in both halves', () => {
    raise({ server: '   ' })

    expect(sessionMcpSetupRequest('s1').get()).toBeNull()
    expect(toolParts('s1')).toEqual([])
  })

  it('parks the turn on the user so Esc will not interrupt it', () => {
    raise()

    expect(sessionAwaitingInput('s1').get()).toBe(true)
  })

  // Unlike `clarify.expire`, this one IS consumed: an expired setup card can
  // only offer to install a server the agent already gave up on, and every
  // button on it would run a real install against a returned tool.
  it('clears the card when the gateway says the request expired', () => {
    raise()
    routeGatewayEvent(event('mcp.setup.expire', { request_id: 'req-1' }))

    expect(sessionMcpSetupRequest('s1').get()).toBeNull()
  })

  // A SECOND request that arrived while the first was expiring must survive.
  it('leaves a different request alone on expire', () => {
    raise()
    routeGatewayEvent(event('mcp.setup.expire', { request_id: 'req-stale' }))

    expect(sessionMcpSetupRequest('s1').get()?.requestId).toBe('req-1')
  })

  it('releases the request when the setup tool returns, however it ended', () => {
    raise()
    routeGatewayEvent(event('tool.complete', { name: 'setup_mcp', tool_id: 'call_abc123', result: '' }))

    expect(sessionMcpSetupRequest('s1').get()).toBeNull()
    expect($sessionStates.get().s1?.needsInput).toBe(false)
  })

  it('leaves it parked while some other tool finishes', () => {
    raise()
    routeGatewayEvent(event('tool.complete', { name: 'bash', tool_id: 'call_x', result: 'ok' }))

    expect(sessionMcpSetupRequest('s1').get()?.requestId).toBe('req-1')
  })

  // The fail-closed guard drops events for a session with no slice — except for
  // a blocking prompt, whose agent is parked. `setup_mcp` costs ten minutes, the
  // most of any bridge, so it is exactly the one that must not be dropped.
  it('mints a slice for a background session it has never seen', () => {
    raise({}, 's-background')

    expect(sessionMcpSetupRequest('s-background').get()?.requestId).toBe('req-1')
    expect(toolParts('s-background')).toHaveLength(1)
  })
})
