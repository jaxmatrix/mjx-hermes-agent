import { connectionIdOf } from '@/lib/backend-scope'
import { listProfilesRich } from '@/lib/gateway-rpc'

import { $connection } from './connection'
import { $connectionReady } from './connection-ready'
import { requestForSession } from './session-request-router'

/**
 * The multi-connection SHAPE, with a single-connection body.
 *
 * MJXHRM-446 owns the registry — the Rust store, the descriptors, the
 * per-connection credentials, the health probe. What ships here is the SDK
 * signature every one of those answers has to fit, plus the honest one-row
 * answer for the one connection this app has today. 446 calls
 * `setPluginConnectionSource(registryConnectionSource)` from its own module and
 * edits NOTHING in `src/sdk/index.ts`.
 *
 * A refusal is SHAPED, never an empty success (`store/agent-read-requests.ts`'s
 * `drive()` rule): an empty answer reads to the caller as "it worked and there
 * is nothing there", which is the one thing a routing failure must not look
 * like.
 */

export interface PluginConnection {
  /** Registry connection id. `'local'` for the primary — the identity
   *  `connectionIdOf` gives, so this cannot drift from the pool's scope key. */
  id: string
  label: string
  /** Gateway mode: `local` | `remote` | `ssh` | `cloud` | … Widened to `string`
   *  so a plugin never depends on the app's own mode union. */
  kind: string
  /** The connection the app is routed to. Exactly one, today and after 446. */
  primary: boolean
}

export interface PluginAgent {
  connectionId: string
  profile: string
  label: string
  isDefault: boolean
}

export interface PluginAgentRoster {
  agents: PluginAgent[]
  /** Per-connection outcome. A connection that failed carries its error rather
   *  than vanishing from the roster — a missing row and a broken row are
   *  different facts. */
  sources: { connectionId: string; error?: string; ok: boolean }[]
}

export interface PluginProfileRoute {
  connectionId: string
  profile: string
}

export type PluginAgentHandle =
  | { ok: false; error: string }
  | { ok: true; connectionId: string; profile: string }

/** Agent routing beyond the live connection does not exist yet. Deliberately NOT
 *  i18n'd: it is read by a PLUGIN, not shown to a user (recipe 6.10's last
 *  line, the `PREVIEW_ACT_UNSUPPORTED` precedent). */
export const AGENT_ROUTING_UNAVAILABLE = 'AGENT_ROUTING_UNAVAILABLE'

export interface PluginConnectionSource {
  connections: () => Promise<PluginConnection[]>
  agents: () => Promise<PluginAgentRoster>
  ensureAgent: (connectionId: string, profile: string) => Promise<PluginAgentHandle>
  profileRoutes: () => Promise<PluginProfileRoute[]>
}

function liveConnectionId(): string {
  return connectionIdOf($connection.get())
}

function describeLiveConnection(): null | PluginConnection {
  const connection = $connection.get()

  if (!connection || !$connectionReady.get()) {
    return null
  }

  return {
    // NEVER the token, the password or the URL's userinfo. Not a 446 detail —
    // a hard rule: the SDK hands out an identity, not credentials.
    id: connectionIdOf(connection),
    kind: connection.mode ?? 'remote',
    label: connection.remoteHost || connection.baseUrl,
    primary: true
  }
}

const singleConnectionSource: PluginConnectionSource = {
  agents: async () => {
    const connectionId = liveConnectionId()

    if (!describeLiveConnection()) {
      return { agents: [], sources: [{ connectionId, error: AGENT_ROUTING_UNAVAILABLE, ok: false }] }
    }

    try {
      const roster = await listProfilesRich({ includeSessions: false })

      return {
        agents: roster.profiles.map(profile => ({
          connectionId,
          isDefault: profile.is_default,
          label: profile.display_name || profile.name,
          profile: profile.name
        })),
        sources: [{ connectionId, ok: true }]
      }
    } catch (error) {
      // The connection's own error, carried on its row — the roster still
      // answers, it just answers honestly.
      return {
        agents: [],
        sources: [{ connectionId, error: error instanceof Error ? error.message : String(error), ok: false }]
      }
    }
  },

  connections: async () => {
    const live = describeLiveConnection()

    return live ? [live] : []
  },

  ensureAgent: async (connectionId, profile) => {
    if (connectionId !== liveConnectionId()) {
      return { error: AGENT_ROUTING_UNAVAILABLE, ok: false }
    }

    // The profile has to exist on the connection we DO have; a handle for one
    // that does not is the empty success this refusal style exists to avoid.
    const roster = await singleConnectionSource.agents()

    return roster.agents.some(agent => agent.profile === profile)
      ? { connectionId, ok: true, profile }
      : { error: AGENT_ROUTING_UNAVAILABLE, ok: false }
  },

  profileRoutes: async () => {
    const roster = await singleConnectionSource.agents()

    return roster.agents.map(agent => ({ connectionId: agent.connectionId, profile: agent.profile }))
  }
}

let source: PluginConnectionSource = singleConnectionSource

/** Register the registry's source. Returns a disposer that restores the
 *  single-connection answers. */
export function setPluginConnectionSource(next: PluginConnectionSource): () => void {
  source = next

  return () => {
    if (source === next) {
      source = singleConnectionSource
    }
  }
}

export function pluginConnectionSource(): PluginConnectionSource {
  return source
}

/**
 * A plugin's RPC to one agent, dispatched through MJXHRM-480's session router.
 *
 * Routed rather than sent: when 446 swaps the router in, this gains
 * multi-connection reach with no SDK edit. `storedSessionId` is null because a
 * profile-scoped call is not about one conversation.
 */
export async function requestPluginProfile<T>(
  route: PluginProfileRoute,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return requestForSession<T>(null, method, params, undefined, route.profile)
}
