import type { GatewayEvent } from '@/gateway'
import { atom } from '@/store/atom'
import { requestGateway } from '@/store/gateway'

// Lean chat model + the gateway-event reducer. This is a mobile-first port of the
// desktop message stream (apps/desktop/src/app/session/hooks/use-message-stream):
// it handles the core streaming vocabulary faithfully — message.start/delta/
// complete, reasoning.delta, tool.start/complete, status.update, approval.request
// — without the full assistant-ui parts model. Richer rendering can be layered on.

export type Role = 'user' | 'assistant'

export interface ToolCall {
  key: string
  name: string
  done: boolean
}

export interface ChatMessage {
  id: string
  role: Role
  text: string
  reasoning: string
  tools: ToolCall[]
  streaming: boolean
}

export interface ApprovalRequest {
  command: string
  description: string
  allowPermanent: boolean
}

// Canonical gateway choices (ui-tui/src/components/prompts.tsx).
export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

// prompt.submit is a long-lived request (a full turn); match the desktop's cap.
const PROMPT_SUBMIT_TIMEOUT_MS = 1_800_000

export const $messages = atom<ChatMessage[]>([])
export const $busy = atom(false)
export const $statusLine = atom('')
export const $approval = atom<ApprovalRequest | null>(null)
export const $sessionId = atom<string | null>(null)

let messageCounter = 0
const nextId = (): string => `m${++messageCounter}-${Date.now()}`

function coerceText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(coerceText).join('')
  return ''
}

function update(fn: (messages: ChatMessage[]) => ChatMessage[]): void {
  $messages.set(fn($messages.get()))
}

function newAssistant(): ChatMessage {
  return { id: nextId(), role: 'assistant', text: '', reasoning: '', tools: [], streaming: true }
}

/** Return `messages` with a guaranteed streaming assistant message at the tail. */
function withActiveAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant' && last.streaming) return messages
  return [...messages, newAssistant()]
}

/** Immutably patch the active (streaming) assistant message. */
function patchActive(messages: ChatMessage[], patch: (m: ChatMessage) => ChatMessage): ChatMessage[] {
  const next = withActiveAssistant(messages)
  const index = next.length - 1
  const copy = next.slice()
  copy[index] = patch(next[index])
  return copy
}

export function handleGatewayEvent(event: GatewayEvent): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>

  switch (event.type) {
    case 'message.start':
      $busy.set(true)
      $statusLine.set('')
      update(withActiveAssistant)
      break

    case 'message.delta':
      update(messages => patchActive(messages, m => ({ ...m, text: m.text + coerceText(payload.text) })))
      break

    case 'reasoning.delta':
    case 'reasoning.available':
      update(messages => patchActive(messages, m => ({ ...m, reasoning: m.reasoning + coerceText(payload.text) })))
      break

    case 'tool.start':
    case 'tool.progress':
    case 'tool.generating': {
      const name = coerceText(payload.name) || 'tool'
      const key = coerceText(payload.tool_id) || name
      update(messages =>
        patchActive(messages, m =>
          m.tools.some(t => t.key === key) ? m : { ...m, tools: [...m.tools, { key, name, done: false }] }
        )
      )
      break
    }

    case 'tool.complete': {
      const key = coerceText(payload.tool_id) || coerceText(payload.name)
      update(messages =>
        patchActive(messages, m => ({ ...m, tools: m.tools.map(t => (t.key === key ? { ...t, done: true } : t)) }))
      )
      break
    }

    case 'message.complete':
      $busy.set(false)
      $statusLine.set('')
      update(messages => messages.map(m => (m.streaming ? { ...m, streaming: false } : m)))
      break

    case 'status.update':
      $statusLine.set(coerceText(payload.status) || coerceText(payload.message) || '')
      break

    case 'approval.request':
      $approval.set({
        command: coerceText(payload.command),
        description: coerceText(payload.description) || 'dangerous command',
        allowPermanent: payload.allow_permanent !== false
      })
      break

    case 'error':
      $busy.set(false)
      $statusLine.set(coerceText(payload.message) || 'Something went wrong')
      update(messages => messages.map(m => (m.streaming ? { ...m, streaming: false } : m)))
      break

    default:
      // gateway.ready, session.info, thinking.delta, moa.*, subagent.* — ignored
      // in the lean model; the connection is already reflected by $gatewayState.
      break
  }
}

export async function sendPrompt(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || $busy.get()) return

  update(messages => [
    ...messages,
    { id: nextId(), role: 'user', text: trimmed, reasoning: '', tools: [], streaming: false }
  ])
  $busy.set(true)
  $statusLine.set('')

  try {
    let sessionId = $sessionId.get()
    if (!sessionId) {
      const created = await requestGateway<{ session_id: string }>('session.create', { cols: 96 })
      sessionId = created.session_id
      $sessionId.set(sessionId)
    }
    await requestGateway('prompt.submit', { session_id: sessionId, text: trimmed }, PROMPT_SUBMIT_TIMEOUT_MS)
  } catch (err) {
    $busy.set(false)
    $statusLine.set(err instanceof Error ? err.message : String(err))
  }
}

export async function respondApproval(choice: ApprovalChoice): Promise<void> {
  const sessionId = $sessionId.get()
  $approval.set(null)
  try {
    await requestGateway('approval.respond', { choice, session_id: sessionId ?? undefined })
  } catch {
    // The turn may have already moved on; the atom is the source of truth.
  }
}

export function resetChat(): void {
  $messages.set([])
  $sessionId.set(null)
  $busy.set(false)
  $statusLine.set('')
  $approval.set(null)
}
