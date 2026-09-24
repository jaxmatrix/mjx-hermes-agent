/**
 * Universal-only resume/replay helpers for blocking prompts (clarify, MCP setup).
 * Desktop AUTO modules (`clarify.ts`, `mcp-setup.ts`) stay thin; absorb must not
 * graft onto them. Listed in `sync/protected.txt`.
 */

import type { GatewayEvent } from '@/gateway'
import { coerceText } from '@/lib/session-key-messages'
import {
  type ClarifyRequest,
  normalizeChoices,
  normalizeQuestions,
  setClarifyRequest,
  warnDroppedChoices
} from '@/store/clarify'
import { requestGateway } from '@/store/gateway-client'
import type { McpSetupRequest } from '@/store/mcp-setup'
import {
  clearMcpSetupRequest,
  sessionMcpSetupRequest,
  setMcpSetupRequest
} from '@/store/mcp-setup'
import { notifyError } from '@/store/notifications'
import { setPetActivity } from '@/store/pet'
import { setSessionClarify, setSessionMcpSetup } from '@/store/prompt-session-bridge'
import { reduceSessionState } from '@/store/session-reducer'
import { updateSession } from '@/store/session-state-types'
import type { SessionResumeResult } from '@/types/hermes'

export function readChoices(
  source: 'gateway' | 'tool_args',
  question: string,
  rawChoices: unknown
): string[] | null {
  const choices = normalizeChoices(rawChoices)

  if (Array.isArray(rawChoices) && rawChoices.length > 0 && choices.length === 0) {
    warnDroppedChoices(source, question, rawChoices)
  }

  return choices.length > 0 ? choices : null
}

export function readLockedAnswers(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }

  const locked: Record<string, string> = {}

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === 'string' && typeof value === 'string') {
      locked[key] = value
    }
  }

  return Object.keys(locked).length > 0 ? locked : undefined
}

export function readMcpSetupAction(value: unknown): McpSetupRequest['action'] {
  if (value === 'enable' || value === 'authorize') {
    return value
  }

  return 'install'
}

export function readMcpSetupRequest(payload: unknown): Omit<McpSetupRequest, 'sessionId'> | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const row = payload as Record<string, unknown>
  const requestId = typeof row.request_id === 'string' ? row.request_id.trim() : ''
  const server = typeof row.server === 'string' ? row.server.trim() : ''

  if (!requestId || !server) {
    return null
  }

  return {
    action: readMcpSetupAction(row.action),
    reason: typeof row.reason === 'string' ? row.reason : '',
    requestId,
    server
  }
}

function foldResumeEvent(key: string, type: string, payload: Record<string, unknown>): void {
  updateSession(key, state => reduceSessionState(state, { type } as GatewayEvent, payload))
}

const GATEWAY_EVENT_BY_METHOD: Record<string, string> = {
  clarify: 'clarify.request',
  setup_mcp: 'mcp.setup.request'
}

function openRequestPayload(
  resumed: Pick<SessionResumeResult, 'open_requests'>,
  method: string
): Record<string, unknown> | null {
  const entry = (resumed.open_requests ?? []).find(row => row.method === method)

  if (!entry?.params || typeof entry.params !== 'object') {
    return null
  }

  const params = { ...(entry.params as Record<string, unknown>) }
  const wireId = coerceText(params.request_id) || entry.id

  if (!wireId) {
    return null
  }

  params.request_id = wireId

  return params
}

export function applyResumedClarify(key: string, resumed: Pick<SessionResumeResult, 'open_requests'>): boolean {
  const payload = openRequestPayload(resumed, 'clarify')

  if (!payload) {
    return false
  }

  const requestId = coerceText(payload.request_id)
  const questions = normalizeQuestions(payload.questions)
  const question = coerceText(payload.question) || coerceText(payload.prompt) || coerceText(payload.message)

  if (!requestId || (!question && questions.length === 0)) {
    return false
  }

  const request: ClarifyRequest =
    questions.length > 0
      ? {
          choices: null,
          lockedAnswers: readLockedAnswers(payload.answers),
          multiSelect: false,
          question: '',
          questions,
          requestId,
          sessionId: key
        }
      : {
          choices: readChoices('gateway', question, payload.choices),
          multiSelect: payload.multi_select === true,
          question,
          requestId,
          sessionId: key
        }

  setSessionClarify(key, request)
  setClarifyRequest(request)
  foldResumeEvent(key, 'clarify.request', payload)

  return true
}

export function applyResumedMcpSetup(key: string, resumed: Pick<SessionResumeResult, 'open_requests'>): boolean {
  const payload = openRequestPayload(resumed, 'setup_mcp')

  if (!payload) {
    return false
  }

  const request = readMcpSetupRequest(payload)

  if (!request) {
    return false
  }

  setSessionMcpSetup(key, request)
  setMcpSetupRequest({ ...request, sessionId: key })
  foldResumeEvent(key, 'mcp.setup.request', payload)

  return true
}

/** Gateway-backed skip used by the composer path (see `mcp-setup.test.ts`). */
export async function skipMcpSetupRequest(sessionId: string | null | undefined): Promise<boolean> {
  const scopedId = sessionId ?? null
  const request = sessionMcpSetupRequest(scopedId).get()

  if (!request) {
    return false
  }

  const snapshot = { ...request, sessionId: request.sessionId ?? sessionId ?? null }
  clearMcpSetupRequest(request.requestId, request.sessionId)

  try {
    await requestGateway('mcp.setup.respond', {
      request_id: request.requestId,
      result: JSON.stringify({ server: request.server, status: 'declined' })
    })
  } catch (error) {
    if (sessionMcpSetupRequest(scopedId).get()?.requestId !== snapshot.requestId) {
      notifyError(error, 'Could not skip MCP setup')

      return true
    }

    setSessionMcpSetup(scopedId ?? '', snapshot)
    setMcpSetupRequest(snapshot)
    notifyError(error, 'Could not skip MCP setup')

    return true
  }

  setPetActivity({ awaitingInput: false })

  return true
}
