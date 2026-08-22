import { getHermesConfigRecord, saveMcpServers } from '@/hermes'

// Shape helpers for the `mcp_servers` config map, shared by everything that
// reads or writes it: the MCP tab editor, the paste-anything importer, and the
// `hermes://mcp/install` deeplink dialog. These agree on what a server entry
// looks like, so they belong in one place — a config written by one path has to
// be readable by the others.

export type McpServers = Record<string, Record<string, unknown>>

export const isServerShape = (value: Record<string, unknown>) =>
  typeof value.command === 'string' || typeof value.url === 'string'

/** Cursor/Claude write `type`; Hermes reads `transport`. Normalizing on the way
 *  in makes pasted configs behave identically under the CLI/TUI loader. */
export function normalizeEntry(entry: Record<string, unknown>): Record<string, unknown> {
  if (typeof entry.type === 'string' && entry.transport === undefined) {
    const { type, ...rest } = entry

    return { ...rest, transport: type }
  }

  return entry
}

/** The `mcp_servers` map out of a config record, or `{}` when absent/malformed. */
export function getServers(config: { mcp_servers?: unknown } | null): McpServers {
  const raw = config?.mcp_servers

  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as McpServers) : {}
}

/**
 * Write ONE server into `mcp_servers`, merging over the freshest map on the
 * backend. Returns the map that landed.
 *
 * The merge-over-fresh is not optional: `saveMcpServers` PUTs the whole
 * document, so writing over a snapshot taken any earlier silently deletes every
 * server added since — by the Capabilities editor, a deep link, or the agent.
 * This is the same three-step the `hermes://mcp/install` dialog performs
 * (`app/mcp-install-deeplink-dialog.tsx`), lifted here so the composer pill and
 * the `setup_mcp` consent card share it instead of growing a third copy.
 *
 * Profile: the REST default (the app-wide profile the client is pinned to), the
 * same one a live chat session's agent is running under — which is what makes
 * the `reload.mcp` write-through that follows an install reach a gateway whose
 * config actually contains the new server. Callers editing some OTHER profile's
 * config (the Capabilities scope picker) pass it explicitly.
 */
export async function writeMcpServerEntry(
  name: string,
  entry: Record<string, unknown>,
  profile?: null | string
): Promise<McpServers> {
  const next = { ...getServers(await getHermesConfigRecord(profile)), [name]: normalizeEntry(entry) }

  await saveMcpServers(next, profile ?? undefined)

  return next
}

/**
 * Drop ONE server from `mcp_servers`, again merging over the freshest map.
 *
 * The rollback half of `writeMcpServerEntry`: a connect flow that dies after the
 * config write (a cancelled OAuth, a closed browser tab) must leave NO server
 * behind. "Decline" means no server, not an unauthorized entry squatting in
 * config that the next turn will try to spawn and fail on.
 */
export async function removeMcpServerEntry(name: string, profile?: null | string): Promise<void> {
  const { [name]: _dropped, ...rest } = getServers(await getHermesConfigRecord(profile))

  await saveMcpServers(rest, profile ?? undefined)
}
