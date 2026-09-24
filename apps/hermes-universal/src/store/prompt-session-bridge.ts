/**
 * Legacy prompt-session API names used by universal's protected islands
 * (chat lifecycle, event-router, overlays) after desktop renamed the atoms.
 *
 * Desktop (AUTO) owns `store/prompts.ts`, `store/clarify.ts`, `store/mcp-setup.ts`.
 * Do NOT re-add these names onto those files — absorb would wipe them. This
 * module is listed in `sync/protected.txt`.
 *
 * Mapping:
 *   $approval / setSessionApproval / clearSessionApproval  → prompts queues / set / clear
 *   $clarify  / setSessionClarify  / clearSessionClarify   → clarify store
 *   $sudo / $secret likewise
 *   setSessionMcpSetup / clearSessionMcpSetup              → mcp-setup store
 *
 * Active-session views key on `$activeSessionKey` (unified map), not desktop's
 * `$activeSessionId` atom — on universal that atom is the STORED id alias, while
 * the event router keys prompts by the RUNTIME map key.
 */
import { computed } from '@/store/atom'
import {
  $clarifyRequests,
  type ClarifyRequest,
  clearClarifyRequest,
  sessionClarifyRequest,
  setClarifyRequest
} from '@/store/clarify'
import {
  clearMcpSetupRequest,
  type McpSetupRequest,
  sessionMcpSetupRequest,
  setMcpSetupRequest
} from '@/store/mcp-setup'
import {
  $approvalRequests,
  $secretRequests,
  $sudoRequests,
  type ApprovalRequest,
  clearApprovalRequest,
  clearSecretRequest,
  clearSudoRequest,
  type SecretRequest,
  sessionApprovalRequest,
  sessionSecretRequest,
  sessionSudoRequest,
  setApprovalRequest,
  setSecretRequest,
  setSudoRequest,
  type SudoRequest
} from '@/store/prompts'
import { $activeSessionKey } from '@/store/session-state-types'

export type { ApprovalRequest, ClarifyRequest, McpSetupRequest, SecretRequest, SudoRequest }
export {
  sessionApprovalRequest,
  sessionClarifyRequest,
  sessionMcpSetupRequest,
  sessionSecretRequest,
  sessionSudoRequest
}

export const $approval = computed([$approvalRequests, $activeSessionKey], (all, key) => all[key] ?? null)
export const $clarify = computed([$clarifyRequests, $activeSessionKey], (requests, key) => requests[key] ?? null)
export const $secret = computed([$secretRequests, $activeSessionKey], (all, key) => all[key] ?? null)
export const $sudo = computed([$sudoRequests, $activeSessionKey], (all, key) => all[key] ?? null)

/** Active-session parked-on-user flag — same sources as prompts' sessionAwaitingInput. */
export const $activeSessionAwaitingInput = computed(
  [$clarifyRequests, $approvalRequests, $sudoRequests, $secretRequests, $activeSessionKey],
  (clarify, approvals, sudos, secrets, key) => Boolean(clarify[key] || approvals[key] || sudos[key] || secrets[key])
)

export function setSessionApproval(
  key: string,
  request: Omit<ApprovalRequest, 'sessionId'> & Partial<Pick<ApprovalRequest, 'sessionId'>>
): void {
  setApprovalRequest({
    ...request,
    sessionId: request.sessionId ?? key,
    command: request.command ?? '',
    description: request.description ?? ''
  })
}

export function clearSessionApproval(sessionId?: string | null, requestId?: string): void {
  clearApprovalRequest(sessionId, requestId)
}

export function setSessionClarify(
  key: string,
  request: Omit<ClarifyRequest, 'sessionId'> & Partial<Pick<ClarifyRequest, 'sessionId'>>
): void {
  setClarifyRequest({ ...request, sessionId: request.sessionId ?? key })
}

export function clearSessionClarify(sessionId?: string | null, requestId?: string): void {
  clearClarifyRequest(requestId, sessionId)
}

export function setSessionSudo(
  key: string,
  request: Omit<SudoRequest, 'sessionId'> & Partial<Pick<SudoRequest, 'sessionId'>>
): void {
  setSudoRequest({ ...request, sessionId: request.sessionId ?? key })
}

export function clearSessionSudo(sessionId?: string | null, requestId?: string): void {
  clearSudoRequest(sessionId, requestId)
}

export function setSessionSecret(
  key: string,
  request: Omit<SecretRequest, 'sessionId'> & Partial<Pick<SecretRequest, 'sessionId'>>
): void {
  setSecretRequest({ ...request, sessionId: request.sessionId ?? key })
}

export function clearSessionSecret(sessionId?: string | null, requestId?: string): void {
  clearSecretRequest(sessionId, requestId)
}

export function setSessionMcpSetup(
  key: string,
  request: Omit<McpSetupRequest, 'sessionId'> & Partial<Pick<McpSetupRequest, 'sessionId'>>
): void {
  setMcpSetupRequest({ ...request, sessionId: request.sessionId ?? key })
}

export function clearSessionMcpSetup(sessionId?: string | null, requestId?: string): void {
  clearMcpSetupRequest(requestId, sessionId)
}
