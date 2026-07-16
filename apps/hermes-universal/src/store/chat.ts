import type { GatewayEvent } from '@/gateway'
import { translateNow } from '@/i18n'
import { playCompletionSound } from '@/lib/completion-sound'
import { speakNow, stopSpeaking } from '@/lib/tts'
import { atom } from '@/store/atom'
import { $autoSpeakReplies } from '@/store/voice-prefs'
import { cwdForNewSession } from '@/store/default-project-dir'
import { requestGateway } from '@/store/gateway'
import { triggerHaptic } from '@/store/haptics'
import { dispatchNativeNotification } from '@/store/native-notifications'
import { notifyError } from '@/store/notifications'
import { $subagentsBySession, upsertSubagent } from '@/store/subagents'
import type { ContextBreakdown, UsageStats } from '@/types/hermes'

// Chat model over the assistant-ui parts vocabulary. The gateway-event reducer
// mutates a plain ChatMessage[] (decoupled from assistant-ui); the runtime
// (app/chat/runtime.tsx) converts these to assistant-ui messages via convertMessage.
//
// Parts are exactly assistant-ui's content-part shapes (text / reasoning /
// tool-call), so conversion is trivial. The streaming reducers are a lean,
// mobile-adapted version of the desktop chat-messages.ts logic.
// FIXME(G): the desktop appendStreamPart coalesces across the opposite channel
// and upsertToolPart matches on arg/context overlap; this is the simpler
// last-part / id-or-name matcher. Port the full logic if interleaving misbehaves.

export type Role = 'assistant' | 'system' | 'user'

export interface TextPart {
  type: 'text'
  text: string
}
export interface ReasoningPart {
  type: 'reasoning'
  text: string
}
export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result?: unknown
  isError?: boolean
}
export type ChatPart = ReasoningPart | TextPart | ToolCallPart

export interface ChatMessage {
  id: string
  role: Role
  parts: ChatPart[]
  /** Assistant message is still streaming. */
  pending?: boolean
  error?: string
}

export interface ApprovalRequest {
  command: string
  description: string
  allowPermanent: boolean
}
export interface ClarifyRequest {
  requestId: string
  prompt: string
}
// Sudo is a password-entry flow (not an allow/deny choice).
export interface SudoRequest {
  requestId: string
  prompt: string
}
export interface SecretRequest {
  requestId: string
  envVar: string
  prompt: string
}

export type ApprovalChoice = 'always' | 'deny' | 'once' | 'session'

const PROMPT_SUBMIT_TIMEOUT_MS = 1_800_000

export const $messages = atom<ChatMessage[]>([])
export const $busy = atom(false)
export const $statusLine = atom('')
export const $approval = atom<ApprovalRequest | null>(null)
export const $clarify = atom<ClarifyRequest | null>(null)
export const $sudo = atom<SudoRequest | null>(null)
export const $secret = atom<SecretRequest | null>(null)
export const $sessionId = atom<string | null>(null)

// --- Statusbar runtime signals (turn/session timers + live context usage) ---
// Mirrors desktop's session-store $turnStartedAt/$sessionStartedAt/$currentUsage,
// wired here since chat.ts owns the turn lifecycle. The statusbar reads these for
// its running-timer, session-timer, and context-usage items.
const EMPTY_USAGE: UsageStats = { calls: 0, input: 0, output: 0, total: 0 }
export const $turnStartedAt = atom<number | null>(null)
export const $sessionStartedAt = atom<number | null>(null)
export const $currentUsage = atom<UsageStats>(EMPTY_USAGE)

// Pull the live context breakdown for the bar label after a settled turn. The
// ContextUsagePanel fetches its own breakdown on open; this only feeds the label.
// Best-effort — keep the prior value on failure.
async function refreshCurrentUsage(): Promise<void> {
  const sessionId = $sessionId.get()
  if (!sessionId) return
  try {
    const b = await requestGateway<ContextBreakdown>('session.context_breakdown', { session_id: sessionId })
    $currentUsage.set({
      ...EMPTY_USAGE,
      context_max: b.context_max,
      context_percent: b.context_percent,
      context_used: b.context_used,
      total: b.context_used ?? 0
    })
  } catch {
    /* leave the prior usage in place */
  }
}

let messageCounter = 0
const nextId = (): string => `m${++messageCounter}-${Date.now()}`

function coerceText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(coerceText).join('')
  return ''
}

function pickArgs(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = payload.args ?? payload.arguments ?? payload.input
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* not JSON */
    }
  }
  return undefined
}

function pickResult(payload: Record<string, unknown>): unknown {
  return payload.result ?? payload.summary ?? payload.message ?? payload.output ?? undefined
}

function update(fn: (messages: ChatMessage[]) => ChatMessage[]): void {
  $messages.set(fn($messages.get()))
}

function newAssistant(): ChatMessage {
  return { id: nextId(), role: 'assistant', parts: [], pending: true }
}

function withActiveAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant' && last.pending) return messages
  return [...messages, newAssistant()]
}

function patchActive(messages: ChatMessage[], patch: (m: ChatMessage) => ChatMessage): ChatMessage[] {
  const next = withActiveAssistant(messages)
  const index = next.length - 1
  const copy = next.slice()
  copy[index] = patch(next[index])
  return copy
}

// Append a streaming delta into the tail part when it's the same channel, else
// open a new part. `replace` swaps the tail same-type part instead of appending
// (used by reasoning.available / moa.reference).
function appendStreamPart(parts: ChatPart[], type: 'reasoning' | 'text', delta: string, replace = false): ChatPart[] {
  if (!delta) return parts
  const last = parts[parts.length - 1]
  if (last && last.type === type) {
    const copy = parts.slice()
    copy[copy.length - 1] = { type, text: replace ? delta : last.text + delta }
    return copy
  }
  return [...parts, { type, text: delta }]
}

function upsertToolPart(parts: ChatPart[], payload: Record<string, unknown>, phase: 'complete' | 'running'): ChatPart[] {
  const nameFromPayload = coerceText(payload.name)
  const id =
    coerceText(payload.tool_id) ||
    coerceText(payload.tool_call_id) ||
    coerceText(payload.id) ||
    `${nameFromPayload || 'tool'}-${parts.length}`
  const args = pickArgs(payload)
  const done = phase === 'complete' ? { result: pickResult(payload), isError: payload.is_error === true } : {}

  const idx = parts.findIndex(
    p => p.type === 'tool-call' && (p.toolCallId === id || (nameFromPayload && p.toolName === nameFromPayload && p.result === undefined))
  )
  const copy = parts.slice()
  if (idx >= 0) {
    const existing = copy[idx] as ToolCallPart
    // A complete event often omits name/args — keep what start supplied.
    copy[idx] = { ...existing, toolName: nameFromPayload || existing.toolName, args: args ?? existing.args, ...done }
  } else {
    copy.push({ type: 'tool-call', toolCallId: id, toolName: nameFromPayload || 'tool', args, ...done })
  }
  return copy
}

export function handleGatewayEvent(event: GatewayEvent): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>

  switch (event.type) {
    case 'message.start':
      $busy.set(true)
      $turnStartedAt.set(Date.now())
      $statusLine.set('')
      stopSpeaking() // interrupt any TTS from the previous turn
      update(withActiveAssistant)
      break

    case 'message.delta':
      update(messages => patchActive(messages, m => ({ ...m, parts: appendStreamPart(m.parts, 'text', coerceText(payload.text)) })))
      break

    case 'reasoning.delta':
      update(messages => patchActive(messages, m => ({ ...m, parts: appendStreamPart(m.parts, 'reasoning', coerceText(payload.text)) })))
      break

    case 'reasoning.available':
      update(messages =>
        patchActive(messages, m => ({ ...m, parts: appendStreamPart(m.parts, 'reasoning', coerceText(payload.text), true) }))
      )
      break

    case 'moa.reference': {
      const label = coerceText(payload.label)
      const idx = coerceText(payload.index)
      const total = coerceText(payload.total)
      const header = `◇ Reference ${idx}/${total}${label ? ` — ${label}` : ''}\n`
      update(messages => patchActive(messages, m => ({ ...m, parts: appendStreamPart(m.parts, 'reasoning', header + coerceText(payload.text)) })))
      break
    }

    case 'tool.start':
    case 'tool.progress':
    case 'tool.generating':
      update(messages => patchActive(messages, m => ({ ...m, parts: upsertToolPart(m.parts, payload, 'running') })))
      break

    case 'tool.complete':
      update(messages => patchActive(messages, m => ({ ...m, parts: upsertToolPart(m.parts, payload, 'complete') })))
      break

    case 'message.complete':
      $busy.set(false)
      $turnStartedAt.set(null)
      $statusLine.set('')
      void refreshCurrentUsage()
      update(messages => messages.map(m => (m.pending ? { ...m, pending: false } : m)))
      // Read the reply aloud when auto-TTS is on (K9).
      if ($autoSpeakReplies.get()) {
        const last = [...$messages.get()].reverse().find(m => m.role === 'assistant')
        const text = last?.parts.filter(p => p.type === 'text').map(p => (p as TextPart).text).join(' ') ?? ''
        if (text.trim()) {
          void speakNow(text)
        }
      }
      dispatchNativeNotification({
        kind: 'turnDone',
        title: translateNow('notifications.native.turnDoneTitle'),
        body: translateNow('notifications.native.turnDoneBody'),
        sessionId: $sessionId.get()
      })
      // Turn-end audio cue (gated by $hapticsMuted). Mirrors desktop gateway-event.
      playCompletionSound()
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
      void triggerHaptic('warning')
      dispatchNativeNotification({
        kind: 'approval',
        title: translateNow('notifications.native.approvalTitle'),
        body: coerceText(payload.command) || coerceText(payload.description),
        sessionId: $sessionId.get()
      })
      break

    case 'clarify.request':
      $clarify.set({
        requestId: coerceText(payload.request_id),
        prompt: coerceText(payload.prompt) || coerceText(payload.message)
      })
      break

    case 'sudo.request':
      $sudo.set({
        requestId: coerceText(payload.request_id),
        prompt: coerceText(payload.prompt) || coerceText(payload.command) || 'Enter your sudo password'
      })
      break

    case 'secret.request':
      $secret.set({
        requestId: coerceText(payload.request_id),
        envVar: coerceText(payload.env_var),
        prompt: coerceText(payload.prompt) || coerceText(payload.message)
      })
      break

    case 'error':
      $busy.set(false)
      $turnStartedAt.set(null)
      $statusLine.set(coerceText(payload.message) || 'Something went wrong')
      update(messages => messages.map(m => (m.pending ? { ...m, pending: false, error: coerceText(payload.message) } : m)))
      dispatchNativeNotification({
        kind: 'turnError',
        title: translateNow('notifications.native.turnErrorTitle'),
        body: coerceText(payload.message),
        sessionId: $sessionId.get()
      })
      break

    default:
      // Subagent lifecycle (spawn/start/thinking/tool/progress/complete) feeds
      // the Agents view's spawn tree, keyed by the active runtime session.
      if (event.type.startsWith('subagent.')) {
        const sid = $sessionId.get() ?? 'active'
        const createIfMissing = event.type === 'subagent.spawn_requested' || event.type === 'subagent.start'
        upsertSubagent(sid, payload, createIfMissing, event.type)
      }
      // gateway.ready, session.info, thinking.delta, moa.aggregating handled elsewhere.
      // FIXME(G): richer status/session handling.
      break
  }
}

/** Lazily create the session (needed before prompt.submit or file.attach). */
export async function ensureSession(): Promise<string> {
  let sessionId = $sessionId.get()
  if (!sessionId) {
    // A configured default project directory pre-attaches new LOCAL chats to that
    // folder (desktop parity); the gateway resolves its own default cwd otherwise.
    const cwd = cwdForNewSession()
    const created = await requestGateway<{ session_id: string }>('session.create', {
      cols: 96,
      ...(cwd && { cwd })
    })
    sessionId = created.session_id
    $sessionId.set(sessionId)
    // Runtime session clock starts when we create the session (statusbar session
    // timer). Resumed/loaded sessions have no reliable start on this client, so
    // the timer stays hidden for them.
    $sessionStartedAt.set(Date.now())
  }
  return sessionId
}

export async function sendPrompt(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || $busy.get()) return
  stopSpeaking() // silence any TTS when the user sends a new prompt

  update(messages => [...messages, { id: nextId(), role: 'user', parts: [{ type: 'text', text: trimmed }] }])
  $busy.set(true)
  $turnStartedAt.set(Date.now())
  $statusLine.set('')

  try {
    const sessionId = await ensureSession()
    await requestGateway('prompt.submit', { session_id: sessionId, text: trimmed }, PROMPT_SUBMIT_TIMEOUT_MS)
  } catch (err) {
    $busy.set(false)
    $turnStartedAt.set(null)
    $statusLine.set(err instanceof Error ? err.message : String(err))
    notifyError(err, 'Message failed to send')
  }
}

export async function respondApproval(choice: ApprovalChoice): Promise<void> {
  const sessionId = $sessionId.get()
  $approval.set(null)
  try {
    await requestGateway('approval.respond', { choice, session_id: sessionId ?? undefined })
  } catch {
    /* turn may have moved on */
  }
}

export async function respondClarify(answer: string): Promise<void> {
  const req = $clarify.get()
  $clarify.set(null)
  if (!req) return
  try {
    await requestGateway('clarify.respond', { request_id: req.requestId, answer })
  } catch {
    /* turn may have moved on */
  }
}

export async function respondSudo(password: string): Promise<void> {
  const req = $sudo.get()
  $sudo.set(null)
  if (!req) return
  try {
    await requestGateway('sudo.respond', { request_id: req.requestId, password })
  } catch {
    /* turn may have moved on */
  }
}

export async function respondSecret(value: string): Promise<void> {
  const req = $secret.get()
  $secret.set(null)
  if (!req) return
  try {
    await requestGateway('secret.respond', { request_id: req.requestId, value })
  } catch {
    /* turn may have moved on */
  }
}

export function resetChat(): void {
  $messages.set([])
  $sessionId.set(null)
  $busy.set(false)
  $turnStartedAt.set(null)
  $sessionStartedAt.set(null)
  $currentUsage.set(EMPTY_USAGE)
  $statusLine.set('')
  $approval.set(null)
  $clarify.set(null)
  $sudo.set(null)
  $secret.set(null)
  $subagentsBySession.set({})
  stopSpeaking()
}
