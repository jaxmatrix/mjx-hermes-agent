import {
  getMcpCatalog,
  installMcpCatalogEntry,
  listMcpServers,
  type McpTestResult,
  setMcpServerEnabled,
  testMcpServer
} from '@/hermes'
import { atom } from '@/store/atom'
import { $sessionId } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import type { McpCatalogEntry, McpServerSummary } from '@/types/hermes'

// MCP servers store — configured servers + the installable catalog. Toggling or
// installing reloads MCP tool schemas live via the `reload.mcp` gateway RPC
// (reloads schemas only — does NOT restart the gateway, so it's safe remotely).
export const $mcpServers = atom<McpServerSummary[]>([])
export const $mcpLoading = atom(false)
export const $mcpError = atom<string | null>(null)

export async function refreshMcp(): Promise<void> {
  $mcpLoading.set(true)
  $mcpError.set(null)
  try {
    $mcpServers.set((await listMcpServers()).servers)
  } catch (err) {
    $mcpError.set(err instanceof Error ? err.message : 'MCP servers failed to load')
  } finally {
    $mcpLoading.set(false)
  }
}

async function reloadMcp(onFail: string): Promise<void> {
  try {
    await requestGateway('reload.mcp', { confirm: true, session_id: $sessionId.get() ?? undefined })
  } catch (err) {
    notifyError(err, onFail)
  }
}

export async function setMcpEnabled(name: string, enabled: boolean, reloadFailMsg: string): Promise<void> {
  const prev = $mcpServers.get()
  $mcpServers.set(prev.map(s => (s.name === name ? { ...s, enabled } : s)))
  try {
    await setMcpServerEnabled(name, enabled)
    await reloadMcp(reloadFailMsg)
  } catch (err) {
    $mcpServers.set(prev)
    notifyError(err, `Failed to update ${name}`)
  }
}

export function testMcp(name: string): Promise<McpTestResult> {
  return testMcpServer(name)
}

export async function loadMcpCatalog(): Promise<McpCatalogEntry[]> {
  return (await getMcpCatalog()).entries
}

/** Install a catalog entry (with any required env), refresh + reload. */
export async function installMcp(name: string, env: Record<string, string>, reloadFailMsg: string): Promise<boolean> {
  try {
    await installMcpCatalogEntry(name, env)
    await refreshMcp()
    await reloadMcp(reloadFailMsg)
    return true
  } catch (err) {
    notifyError(err, `Failed to install ${name}`)
    return false
  }
}
