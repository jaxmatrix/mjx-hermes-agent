import type { ChatMessage, ChatPart, ToolCallPart } from '@/store/chat'
import type { SessionMessage } from '@/types/hermes'

// Hydrate a stored transcript (SessionMessage[]) into our lean assistant-ui parts
// model (Hc1). Lean port of desktop apps/desktop/src/lib/chat-messages.ts
// toChatMessages — the essential grouping (attach role:'tool' results to the
// preceding assistant's tool-call by tool_call_id/name; buffer tool-only
// assistants onto the surrounding turn) — dropping media/todos/generated-image/
// branch/timestamp/argsText concerns.
// FIXME(H): displayContentForMessage strips the "Attached Context" marker only;
// no ref reinjection.

function textFromUnknown(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (depth > 2) return ''
  if (Array.isArray(value)) return value.map(item => textFromUnknown(item, depth + 1)).join('')
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>
    const nested = textFromUnknown(row.text ?? row.output_text ?? row.content ?? row.message, depth + 1)
    if (nested) return nested
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return String(value)
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function firstNonEmptyObject(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const parsed = parseMaybeJsonObject(value)
    if (Object.keys(parsed).length > 0) return parsed
  }
  return {}
}

const ATTACHED_CONTEXT_MARKER_RE = /(?:^|\n)--- Attached Context ---\s*\n/
const CONTEXT_WARNINGS_MARKER_RE = /(?:^|\n)--- Context Warnings ---[\s\S]*$/

function displayContentForMessage(role: SessionMessage['role'], content: unknown): string {
  const text = textFromUnknown(content)
  if (role !== 'user') return text
  const marker = text.match(ATTACHED_CONTEXT_MARKER_RE)
  if (!marker || marker.index === undefined) return text.replace(CONTEXT_WARNINGS_MARKER_RE, '').trim()
  return text.slice(0, marker.index).replace(CONTEXT_WARNINGS_MARKER_RE, '').trim()
}

function parseStoredToolResult(content: unknown): unknown {
  if (content && typeof content === 'object') return content
  const text = textFromUnknown(content)
  if (!text.trim()) return ''
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function argsOrUndefined(args: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(args).length > 0 ? args : undefined
}

function toolPartFromStoredCall(call: unknown, fallbackIndex: number): ToolCallPart {
  const row = recordFromUnknown(call) ?? {}
  const fn = recordFromUnknown(row.function)
  const id = String(row.id || row.tool_call_id || `stored-tool-${fallbackIndex}`)
  const toolName = String(
    row.name || row.tool_name || fn?.name || (recordFromUnknown(row.input)?.name as string | undefined) || 'tool'
  )
  const args = firstNonEmptyObject(fn?.arguments, row.arguments, row.args, row.input)
  return { type: 'tool-call', toolCallId: id, toolName, args: argsOrUndefined(args) }
}

function matchesTool(part: ChatPart, toolCallId: string | undefined, toolName: string): boolean {
  return (
    part.type === 'tool-call' &&
    ((toolCallId != null && part.toolCallId === toolCallId) || (toolCallId == null && part.toolName === toolName))
  )
}

function applyResultToParts(parts: ChatPart[], toolMessage: SessionMessage): ChatPart[] | null {
  const toolCallId = toolMessage.tool_call_id || undefined
  const toolName = toolMessage.tool_name || toolMessage.name || 'tool'
  const content = toolMessage.content || toolMessage.text || toolMessage.context || toolMessage.name
  const index = parts.findIndex(part => matchesTool(part, toolCallId, toolName))
  if (index < 0) return null
  const next = parts.slice()
  next[index] = { ...(next[index] as ToolCallPart), result: parseStoredToolResult(content), isError: false }
  return next
}

function applyResultToMessages(messages: ChatMessage[], toolMessage: SessionMessage): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'assistant') continue
    const next = applyResultToParts(messages[i].parts, toolMessage)
    if (next) {
      messages[i] = { ...messages[i], parts: next }
      return true
    }
  }
  return false
}

function storedToolMessagePart(toolMessage: SessionMessage, fallbackIndex: number): ToolCallPart {
  const name = toolMessage.tool_name || toolMessage.name || 'tool'
  const context = textFromUnknown(toolMessage.context || toolMessage.text || toolMessage.content || '')
  const args = context ? { context } : {}
  return {
    type: 'tool-call',
    toolCallId: toolMessage.tool_call_id || `stored-tool-message-${fallbackIndex}`,
    toolName: name,
    args: argsOrUndefined(args),
    result: context ? { context } : {},
    isError: false
  }
}

function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('')
}

function withUniqueToolCallIds(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>()
  return messages.map(message => {
    let changed = false
    const parts = message.parts.map((part, index) => {
      if (part.type !== 'tool-call') return part
      const id = part.toolCallId || `${message.id}-tool-${index}`
      if (!seen.has(id)) {
        seen.add(id)
        if (part.toolCallId) return part
        changed = true
        return { ...part, toolCallId: id }
      }
      changed = true
      const unique = `${id}-${message.id}-${index}`
      seen.add(unique)
      return { ...part, toolCallId: unique }
    })
    return changed ? { ...message, parts } : message
  })
}

export function toChatMessages(messages: SessionMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  let pendingToolParts: ChatPart[] = []
  let activeAssistantIndex: null | number = null

  const appendToActiveAssistant = (parts: ChatPart[]): boolean => {
    if (activeAssistantIndex === null) return false
    const active = result[activeAssistantIndex]
    if (!active || active.role !== 'assistant') {
      activeAssistantIndex = null
      return false
    }
    result[activeAssistantIndex] = { ...active, parts: [...active.parts, ...parts] }
    return true
  }

  const flushPendingTools = (index: number) => {
    if (!pendingToolParts.length) return
    if (!appendToActiveAssistant(pendingToolParts)) {
      result.push({ id: `h-tools-${index}`, role: 'assistant', parts: pendingToolParts })
      activeAssistantIndex = result.length - 1
    }
    pendingToolParts = []
  }

  messages.forEach((message, index) => {
    if (message.role === 'tool') {
      const updated = applyResultToParts(pendingToolParts, message)
      if (updated) {
        pendingToolParts = updated
        return
      }
      if (applyResultToMessages(result, message)) return
      pendingToolParts = [...pendingToolParts, storedToolMessagePart(message, index)]
      return
    }

    const content = message.content || message.text || message.context || message.name
    const displayContent = displayContentForMessage(message.role, content)
    const parts: ChatPart[] = []

    const reasoning =
      message.reasoning ||
      message.reasoning_content ||
      (typeof message.reasoning_details === 'string' ? message.reasoning_details : '')
    if (reasoning && message.role === 'assistant') parts.push({ type: 'reasoning', text: String(reasoning) })

    if (displayContent) parts.push({ type: 'text', text: displayContent })

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      parts.push(...message.tool_calls.map((call, i) => toolPartFromStoredCall(call, i)))
    }

    if (!parts.length) {
      if (message.role !== 'assistant') {
        flushPendingTools(index)
        activeAssistantIndex = null
      }
      return
    }

    const isToolOnlyAssistant = message.role === 'assistant' && parts.every(part => part.type === 'tool-call')
    if (isToolOnlyAssistant) {
      pendingToolParts = [...pendingToolParts, ...parts]
      return
    }

    if (message.role === 'assistant') {
      if (pendingToolParts.length) {
        if (!appendToActiveAssistant(pendingToolParts)) parts.unshift(...pendingToolParts)
        pendingToolParts = []
      }
      const active =
        activeAssistantIndex !== null && result[activeAssistantIndex]?.role === 'assistant'
          ? result[activeAssistantIndex]
          : null
      const currentHasTool = parts.some(part => part.type === 'tool-call')
      const activeHasTool = Boolean(active?.parts.some(part => part.type === 'tool-call'))
      if (active && activeAssistantIndex !== null && (currentHasTool || activeHasTool)) {
        result[activeAssistantIndex] = { ...active, parts: [...active.parts, ...parts] }
        return
      }
    } else {
      flushPendingTools(index)
    }

    result.push({ id: `h${index}-${message.role}`, role: message.role, parts })
    activeAssistantIndex = message.role === 'assistant' ? result.length - 1 : null
  })
  flushPendingTools(messages.length)

  return withUniqueToolCallIds(
    result.filter(m => messageText(m).trim() || m.parts.some(part => part.type !== 'text'))
  )
}
