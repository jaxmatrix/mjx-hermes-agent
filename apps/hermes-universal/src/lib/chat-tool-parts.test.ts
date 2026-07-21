import { describe, expect, it } from 'vitest'

import type { ChatPart, ToolCallPart } from '@/store/chat'

import { upsertToolPart } from './chat-tool-parts'

// Payload shapes here mirror what tui_gateway/server.py actually emits:
//   tool.start      {tool_id, name, context}          — NO args
//   tool.complete   {tool_id, name, args, result, duration_s?, summary?, inline_diff?}
//   tool.generating {name}                            — NO id
const tools = (parts: ChatPart[]): ToolCallPart[] => parts.filter((p): p is ToolCallPart => p.type === 'tool-call')

describe('upsertToolPart', () => {
  it('keeps the start context on the running row (the card subtitle)', () => {
    const parts = upsertToolPart([], { context: 'src/app.ts', name: 'read_file', tool_id: 'c1' }, 'running')

    expect(tools(parts)).toHaveLength(1)
    expect(tools(parts)[0].args).toMatchObject({ context: 'src/app.ts' })
    // No result yet — this is what the renderer reads as "still running".
    expect(tools(parts)[0].result).toBeUndefined()
  })

  it('keeps parallel same-name calls distinct without explicit ids', () => {
    let parts = upsertToolPart([], { context: 'tokyo', name: 'web_search' }, 'running')
    parts = upsertToolPart(parts, { context: 'reykjavik', name: 'web_search' }, 'running')

    expect(tools(parts)).toHaveLength(2)

    parts = upsertToolPart(parts, { context: 'tokyo', name: 'web_search', result: { hits: 3 } }, 'complete')
    parts = upsertToolPart(parts, { context: 'reykjavik', name: 'web_search', result: { hits: 7 } }, 'complete')

    expect(tools(parts)).toHaveLength(2)
    expect(tools(parts)[0].result).toMatchObject({ hits: 3 })
    expect(tools(parts)[1].result).toMatchObject({ hits: 7 })
  })

  it('adopts the stable tool_id onto a row opened by an id-less event', () => {
    let parts = upsertToolPart([], { name: 'grep' }, 'running')
    parts = upsertToolPart(parts, { context: 'needle', name: 'grep', tool_id: 'call_1' }, 'running')
    parts = upsertToolPart(parts, { name: 'grep', result: { matches: 2 }, tool_id: 'call_1' }, 'complete')

    expect(tools(parts)).toHaveLength(1)
    expect(tools(parts)[0].toolCallId).toBe('call_1')
    expect(tools(parts)[0].result).toMatchObject({ matches: 2 })
  })

  it('settles a completion that carries no result at all (sub-agent mirrors)', () => {
    let parts = upsertToolPart([], { args: {}, name: 'open', preview: 'child', tool_id: 'submirror:1' }, 'running')
    parts = upsertToolPart(parts, { args: {}, name: 'open', preview: 'child', tool_id: 'submirror:1' }, 'complete')

    // An object — NOT undefined — so the card stops spinning and stops being
    // eligible to swallow the next same-name call.
    expect(tools(parts)[0].result).toEqual({ preview: 'child' })
  })

  it('carries duration / summary / inline_diff onto the result', () => {
    let parts = upsertToolPart([], { context: 'src/a.ts', name: 'edit_file', tool_id: 'e1' }, 'running')
    parts = upsertToolPart(
      parts,
      {
        args: { path: 'src/a.ts' },
        duration_s: 1.25,
        inline_diff: '- old\n+ new',
        name: 'edit_file',
        result: { ok: true },
        summary: 'Edited 1 file',
        tool_id: 'e1'
      },
      'complete'
    )

    expect(tools(parts)[0].result).toMatchObject({
      duration_s: 1.25,
      inline_diff: '- old\n+ new',
      ok: true,
      summary: 'Edited 1 file'
    })
  })

  it('does not let a narrower completion erase the start context', () => {
    let parts = upsertToolPart([], { context: 'find TODOs', name: 'grep', tool_id: 'g1' }, 'running')
    parts = upsertToolPart(parts, { args: { path: '.' }, name: 'grep', result: {}, tool_id: 'g1' }, 'complete')

    expect(tools(parts)[0].args).toMatchObject({ context: 'find TODOs', path: '.' })
  })

  it('keeps a plain-text result instead of flattening it away', () => {
    const parts = upsertToolPart([], { name: 'terminal', result: 'total 4\ndrwx', tool_id: 't1' }, 'complete')

    expect(tools(parts)[0].result).toMatchObject({ output: 'total 4\ndrwx' })
  })

  it('mints unique ids for id-less rows across turns', () => {
    const first = tools(upsertToolPart([], { context: 'a', name: 'grep' }, 'running'))[0]
    const second = tools(upsertToolPart([], { context: 'b', name: 'grep' }, 'running'))[0]

    expect(first.toolCallId).not.toBe(second.toolCallId)
  })
})
