import { describe, expect, it } from 'vitest'

import { directoryEntry, MCP_DIRECTORY } from './mcp-directory'

describe('MCP_DIRECTORY', () => {
  it('has unique names — a duplicate would shadow a vendor in every lookup', () => {
    const names = MCP_DIRECTORY.map(entry => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('points every entry at an https endpoint and https docs', () => {
    for (const entry of MCP_DIRECTORY) {
      expect(new URL(entry.url).protocol, entry.name).toBe('https:')
      expect(new URL(entry.docs).protocol, entry.name).toBe('https:')
    }
  })

  // Keywords and hosts are matched against lowercased draft text / hostnames,
  // so an uppercase entry here can never fire.
  it('keeps keywords and hosts lowercase and non-empty', () => {
    for (const entry of MCP_DIRECTORY) {
      expect(entry.keywords.length, entry.name).toBeGreaterThan(0)

      for (const keyword of entry.keywords) {
        expect(keyword, entry.name).toBe(keyword.toLowerCase())
      }

      for (const host of entry.hosts ?? []) {
        expect(host, entry.name).toBe(host.toLowerCase())
      }
    }
  })

  // GitHub's hosted MCP needs a per-host OAuth app; generic DCR 404s at
  // /register, so advertising it would fail both the pill and setup_mcp.
  it('deliberately omits github', () => {
    expect(directoryEntry('github')).toBeUndefined()
  })

  it('resolves a known entry by name', () => {
    expect(directoryEntry('linear')?.url).toBe('https://mcp.linear.app/mcp')
    expect(directoryEntry('nope')).toBeUndefined()
  })
})
