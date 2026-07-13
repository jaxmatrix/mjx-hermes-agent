import { describe, expect, it } from 'vitest'

import type { ChatPart, ToolCallPart } from '@/store/chat'
import type { SessionMessage } from '@/types/hermes'

import { toChatMessages } from './session-history'

const msg = (m: Partial<SessionMessage>): SessionMessage => m as SessionMessage
const tools = (parts: ChatPart[]): ToolCallPart[] => parts.filter((p): p is ToolCallPart => p.type === 'tool-call')
const texts = (parts: ChatPart[]): string[] =>
  parts.filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text').map(p => p.text)

describe('toChatMessages', () => {
  it('converts plain user/assistant text', () => {
    const out = toChatMessages([msg({ role: 'user', content: 'hi' }), msg({ role: 'assistant', content: 'hello' })])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'hi' }] })
    expect(out[1]).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] })
  })

  it('adds a reasoning part before assistant text', () => {
    const out = toChatMessages([msg({ role: 'assistant', content: 'answer', reasoning: 'because' })])
    expect(out[0].parts.map(p => p.type)).toEqual(['reasoning', 'text'])
    expect(out[0].parts[0]).toMatchObject({ type: 'reasoning', text: 'because' })
  })

  it('attaches a tool result to the tool-call by tool_call_id', () => {
    const out = toChatMessages([
      msg({ role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'grep', arguments: { q: 'x' } } }] }),
      msg({ role: 'tool', tool_call_id: 't1', content: '42 matches' })
    ])
    const tool = tools(out.flatMap(m => m.parts))[0]
    expect(tool).toMatchObject({ toolName: 'grep', result: '42 matches' })
    expect(tool.args).toEqual({ q: 'x' })
  })

  it('matches a tool result by name when no id is present', () => {
    const out = toChatMessages([
      msg({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'ls' } }] }),
      msg({ role: 'tool', tool_name: 'ls', content: 'a b c' })
    ])
    expect(tools(out.flatMap(m => m.parts))[0]).toMatchObject({ toolName: 'ls', result: 'a b c' })
  })

  it('groups a tool-only assistant onto the surrounding text turn', () => {
    const out = toChatMessages([
      msg({ role: 'assistant', content: 'let me check' }),
      msg({ role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'grep' } }] }),
      msg({ role: 'tool', tool_call_id: 't1', content: 'ok' }),
      msg({ role: 'assistant', content: 'done' })
    ])
    const assistants = out.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(tools(assistants[0].parts)).toHaveLength(1)
    expect(texts(assistants[0].parts)).toEqual(['let me check', 'done'])
  })

  it('dedupes duplicate tool-call ids', () => {
    const out = toChatMessages([
      msg({ role: 'assistant', content: 'x', tool_calls: [{ id: 'dup', function: { name: 'a' } }, { id: 'dup', function: { name: 'b' } }] })
    ])
    const ids = tools(out.flatMap(m => m.parts)).map(t => t.toolCallId)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})
