import type { GatewayEvent } from '@/gateway'
import { translateNow } from '@/i18n'
import { playCompletionSound } from '@/lib/completion-sound'
import { speakNow, stopSpeaking } from '@/lib/tts'
import { atom } from '@/store/atom'
import { $autoSpeakReplies } from '@/store/voice-prefs'
import { cwdForNewSession } from '@/store/default-project-dir'
import { requestGateway } from '@/store/gateway'
import { triggerHaptic } from '@/lib/haptics'
import { dispatchNativeNotification } from '@/store/native-notifications'
import { notifyError } from '@/store/notifications'
import { $subagentsBySession, upsertSubagent } from '@/store/subagents'
import type { ContextBreakdown, SessionCreateResponse, UsageStats } from '@/types/hermes'

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

// Live auto-title of the CURRENT runtime session, pushed by the backend's
// `session.title` event (the titler runs async after the first turn). A brand-new
// session isn't in the $sessions list yet and has no $activeStoredSessionId, so
// the chat header can't resolve its title from the list — it reads this instead,
// so the "New session" heading updates on the fly once the title lands.
export const $liveSessionTitle = atom<string>('')

// The ACTIVE chat's working directory — its project directory. Every stored
// session carries one (`SessionInfo.cwd`), so switching chats switches this:
// restored on open/resume (store/session.ts), adopted on create (ensureSession),
// and followed live via `session.info` when the agent relocates itself. Empty
// for a detached chat (no project dir) — consumers should generally read
// `$effectiveCwd` (store/workspace-events), which falls back to the workspace
// root, rather than this raw value.
export const $currentCwd = atom<string>('')

export function setCurrentCwd(cwd: null | string | undefined): void {
  $currentCwd.set(cwd?.trim() || '')
}

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

// See the tool.complete case: lazy to avoid a chat ↔ workspace-events cycle.
async function notifyWorkspaceChangeFromTool(payload: Record<string, unknown>): Promise<void> {
  const { notifyWorkspaceChanged, toolChangedPath, toolMayMutateFiles } = await import('@/store/workspace-events')

  if (toolMayMutateFiles(payload)) {
    notifyWorkspaceChanged(toolChangedPath(payload))
  }
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
  // Coalesce into the most recent same-type part within the current segment
  // (bounded by non-streaming parts like tool calls). The opposite streaming
  // channel (text<->reasoning) is TRANSPARENT — so a final reasoning burst
  // (reasoning.available) that arrives AFTER the response text merges back into
  // the existing reasoning part instead of spawning a duplicate "thinking" block
  // at the end. `replace` swaps the accumulated text for the final version.
  // (Ported from desktop lib/chat-messages.ts appendStreamPart.)
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.type === type) {
      const copy = parts.slice()
      copy[i] = { type, text: replace ? delta : part.text + delta }
      return copy
    }
    if (part.type !== 'text' && part.type !== 'reasoning') {
      break
    }
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
      // A file-mutating tool just finished — nudge the git-mirroring surfaces
      // (coding rail, review pane, file tree) to refresh. Event-driven, not
      // polled: fires exactly when the agent touches the tree. (Desktop does the
      // same in use-message-stream/gateway-event.ts.)
      //
      // Imported lazily: store/workspace-events reads $currentCwd from THIS
      // module for $effectiveCwd, so a static import is a cycle that leaves one
      // side undefined at init (it broke the statusbar's $effectiveCwd read).
      if (payload) {
        void notifyWorkspaceChangeFromTool(payload)
      }
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

    case 'session.title': {
      // Live auto-title push (titler runs async, after the turn). Update the
      // current session's live title so the chat header reflects it on the fly,
      // and patch the sidebar list entry if it's already loaded (decoupled via a
      // dynamic import — store/session imports store/chat, so a static import
      // here would cycle).
      const sid = coerceText(payload.session_id)
      const title = coerceText(payload.title).trim()
      if (title && (!sid || sid === $sessionId.get())) {
        $liveSessionTitle.set(title)
      }
      if (sid && title) {
        void import('@/store/session')
          .then(m => m.setSessions(prev => prev.map(s => (s.id === sid ? { ...s, title } : s))))
          .catch(() => {})
      }
      break
    }

    case 'session.info': {
      // Runtime info for a session. The active chat's agent can relocate itself
      // (entering another repo/worktree via the terminal), so follow its cwd.
      // Apply a session-scoped event only when it targets the active chat; a
      // global broadcast (no session id) only when no chat is open — otherwise a
      // background session would yank the directory out from under the user.
      const eventSessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
      const activeSessionId = $sessionId.get()
      const applies = eventSessionId ? eventSessionId === activeSessionId : !activeSessionId

      // Truthiness-gated (desktop parity): an empty cwd means "unknown", not
      // "detach the current one".
      if (applies && typeof payload.cwd === 'string' && payload.cwd) {
        setCurrentCwd(payload.cwd)
      }

      break
    }

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

/**
 * Lazily create the session (needed before prompt.submit or file.attach).
 * Returns the live gateway `id` (used for prompt.submit / file.attach) AND the
 * durable `storedId` — session.create returns both, and the backend keys the
 * session LIST + `session.title` events on the stored id (which can differ from
 * the runtime id). The sidebar row + $activeStoredSessionId must use `storedId`
 * so the chat header can resolve the session after the list refreshes.
 */
export async function ensureSession(): Promise<{ id: string; storedId: string }> {
  const existing = $sessionId.get()
  if (existing) {
    return { id: existing, storedId: existing }
  }
  // A configured default project directory pre-attaches new LOCAL chats to that
  // folder (desktop parity); the gateway resolves its own default cwd otherwise.
  const cwd = cwdForNewSession()
  const created = await requestGateway<SessionCreateResponse>('session.create', {
    cols: 96,
    ...(cwd && { cwd })
  })
  const id = created.session_id
  $sessionId.set(id)
  // Adopt the runtime's resolved working directory — it normalizes (or defaults)
  // whatever cwd we asked for, so this is the value the agent will actually run
  // in, and what the new chat's stored row should be seeded with.
  setCurrentCwd(created.info?.cwd ?? cwd)
  // Runtime session clock starts when we create the session (statusbar session
  // timer). Resumed/loaded sessions have no reliable start on this client, so
  // the timer stays hidden for them.
  $sessionStartedAt.set(Date.now())
  return { id, storedId: created.stored_session_id ?? id }
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
    const wasNew = !$sessionId.get()
    const { id: sessionId, storedId } = await ensureSession()
    if (wasNew) {
      // New chat: optimistically add it to the sidebar list + mark active, keyed
      // on the STORED id (what the list refresh + session.title use), with the
      // first message as the provisional title (preview). Dynamic import —
      // store/session imports store/chat, so a static import here would cycle.
      void import('@/store/session')
        .then(m => m.registerNewSession(storedId, trimmed))
        .catch(() => {})
    }
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
  // A fresh chat starts in the configured default project dir (if any), not in
  // whatever directory the chat we just left happened to use.
  setCurrentCwd(cwdForNewSession())
  $liveSessionTitle.set('')
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
