import { describe, expect, it } from 'vitest'

import { getServers, isServerShape, normalizeEntry } from './mcp-servers'

describe('normalizeEntry', () => {
  it('renames Cursor/Claude `type` to Hermes `transport`', () => {
    expect(normalizeEntry({ type: 'sse', url: 'https://mcp.example/sse' })).toEqual({
      transport: 'sse',
      url: 'https://mcp.example/sse'
    })
  })

  it('keeps an explicit `transport` and drops nothing else when both are present', () => {
    expect(normalizeEntry({ transport: 'http', type: 'sse', url: 'https://x' })).toEqual({
      transport: 'http',
      type: 'sse',
      url: 'https://x'
    })
  })

  it('leaves a non-string `type` alone — it is not a transport', () => {
    expect(normalizeEntry({ type: 3, url: 'https://x' })).toEqual({ type: 3, url: 'https://x' })
  })

  it('returns entries without `type` untouched', () => {
    const entry = { args: ['-y', 'server-fs'], command: 'npx' }
    expect(normalizeEntry(entry)).toBe(entry)
  })
})

describe('isServerShape', () => {
  it('accepts a stdio entry and an http entry', () => {
    expect(isServerShape({ command: 'npx' })).toBe(true)
    expect(isServerShape({ url: 'https://mcp.example/mcp' })).toBe(true)
  })

  it('rejects a name→config map (the wrapper, not an entry)', () => {
    expect(isServerShape({ linear: { url: 'https://mcp.linear.app/mcp' } })).toBe(false)
  })

  it('rejects non-string command/url', () => {
    expect(isServerShape({ command: 42 })).toBe(false)
    expect(isServerShape({ url: null })).toBe(false)
  })
})

describe('getServers', () => {
  it('reads the mcp_servers map', () => {
    const servers = { linear: { url: 'https://mcp.linear.app/mcp' } }
    expect(getServers({ mcp_servers: servers })).toBe(servers)
  })

  it('degrades to {} for absent, null, array and scalar maps', () => {
    expect(getServers(null)).toEqual({})
    expect(getServers({})).toEqual({})
    expect(getServers({ mcp_servers: [] })).toEqual({})
    expect(getServers({ mcp_servers: 'nope' })).toEqual({})
  })
})
