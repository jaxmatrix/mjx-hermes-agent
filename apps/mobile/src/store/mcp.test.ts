import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { McpServerSummary } from '@/types/hermes'

const server = (over: Partial<McpServerSummary>): McpServerSummary => ({
  name: 's',
  transport: 'stdio',
  command: null,
  args: [],
  url: null,
  enabled: false,
  tools: null,
  ...over
})

vi.mock('@/hermes', () => ({
  listMcpServers: vi.fn(async () => ({ servers: [server({ name: 'fs', enabled: true }), server({ name: 'git' })] })),
  setMcpServerEnabled: vi.fn(async () => ({ ok: true })),
  testMcpServer: vi.fn(async () => ({ ok: true, tools: [{ name: 'a', description: '' }, { name: 'b', description: '' }] })),
  getMcpCatalog: vi.fn(async () => ({ entries: [], diagnostics: [] })),
  installMcpCatalogEntry: vi.fn(async () => ({ ok: true }))
}))

// reload.mcp goes through the gateway; stub it so no live client is needed.
vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn(async () => ({})) }))

import { setMcpServerEnabled } from '@/hermes'
import { requestGateway } from '@/store/gateway'

import { $mcpServers, refreshMcp, setMcpEnabled, testMcp } from './mcp'

const setEnabled = vi.mocked(setMcpServerEnabled)
const rpc = vi.mocked(requestGateway)

describe('mcp store', () => {
  beforeEach(() => {
    setEnabled.mockClear()
    rpc.mockClear()
    $mcpServers.set([])
  })
  afterEach(() => $mcpServers.set([]))

  it('loads configured servers', async () => {
    await refreshMcp()
    expect($mcpServers.get().map(s => s.name)).toEqual(['fs', 'git'])
  })

  it('toggles a server and reloads MCP schemas', async () => {
    await refreshMcp()
    await setMcpEnabled('git', true, 'reload failed')
    expect(setEnabled).toHaveBeenCalledWith('git', true)
    expect(rpc).toHaveBeenCalledWith('reload.mcp', expect.objectContaining({ confirm: true }))
    expect($mcpServers.get().find(s => s.name === 'git')?.enabled).toBe(true)
  })

  it('returns a probe result from testMcp', async () => {
    const res = await testMcp('fs')
    expect(res.ok).toBe(true)
    expect(res.tools).toHaveLength(2)
  })
})
