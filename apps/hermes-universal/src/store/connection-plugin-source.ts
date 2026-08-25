import { backendScopeKey } from '@/lib/backend-scope'
import { $activeConnection } from '@/store/active-connection'
import { $connectionsRegistry, connectionsRoster } from '@/store/connections'
import { leaseSecondary, releaseSecondary } from '@/store/gateway-secondaries'
import {
  AGENT_ROUTING_UNAVAILABLE,
  type PluginAgentHandle,
  type PluginAgentRoster,
  type PluginConnection,
  type PluginConnectionSource,
  type PluginProfileRoute,
  setPluginConnectionSource
} from '@/store/plugin-connection-source'

/**
 * THE MULTI-CONNECTION PLUGIN SOURCE — MJXHRM-455's interface, filled.
 *
 * 455 shipped the shape with an honest one-row body; this supplies the registry
 * body with **zero `src/sdk/index.ts` edits**, which was the whole point of the
 * hook.
 *
 * The SDK view is deliberately NARROWER than the settings view: a plugin has the
 * app's full authority (rule 26), so it gets `{id, label, kind, primary}` and
 * nothing else — no `hasToken`, no `tokenPreview`, no header names. Knowing
 * WHICH gateways exist is routing; knowing that one of them holds a token is a
 * fact about a credential.
 *
 * The refusal style is preserved: an unknown connection id gets a SHAPED
 * `{ok:false, error:'AGENT_ROUTING_UNAVAILABLE'}`, never an empty success —
 * an empty answer reads to the caller as "it worked and there is nothing there",
 * which is the one thing a routing failure must not look like.
 */

const PREWARM_MIN_INTERVAL_MS = 60_000

const lastWarm = new Map<string, number>()

function describe(): PluginConnection[] {
  const registry = $connectionsRegistry.get()
  const active = $activeConnection.get()

  return registry.connections.map(row => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    // "primary" means the connection the app is ROUTED to — what a plugin
    // actually needs to know — not the registry's launch default.
    primary: row.id === active?.connectionId
  }))
}

export const registryConnectionSource: PluginConnectionSource = {
  agents: async (): Promise<PluginAgentRoster> => {
    const roster = await connectionsRoster()
    const labels = new Map($connectionsRegistry.get().connections.map(row => [row.id, row.label]))

    return {
      agents: roster.agents.map(agent => ({
        connectionId: agent.connectionId,
        isDefault: agent.isDefault,
        // The `@name-device` handle, so two boxes serving `default` are
        // distinguishable in a plugin's own UI.
        label: agent.handle === agent.profile ? agent.profile : `${agent.profile} · ${labels.get(agent.connectionId) ?? ''}`,
        profile: agent.profile
      })),
      // A source that failed carries its error rather than vanishing: a missing
      // row and a broken row are different facts.
      sources: roster.sources
    }
  },

  connections: async (): Promise<PluginConnection[]> => describe(),

  ensureAgent: async (connectionId: string, profile: string): Promise<PluginAgentHandle> => {
    const known = $connectionsRegistry.get().connections.some(row => row.id === connectionId)

    if (!known) {
      return { error: AGENT_ROUTING_UNAVAILABLE, ok: false }
    }

    const active = $activeConnection.get()

    // The active source needs no second socket; anything else has to be
    // reachable before a handle is honest about it.
    if (active?.connectionId === connectionId) {
      return { connectionId, ok: true, profile }
    }

    const lease = await leaseSecondary(backendScopeKey(connectionId, profile), connectionId).catch(() => null)

    if (!lease) {
      return { error: AGENT_ROUTING_UNAVAILABLE, ok: false }
    }

    releaseSecondary(lease)

    return { connectionId, ok: true, profile }
  },

  profileRoutes: async (): Promise<PluginProfileRoute[]> => {
    const roster = await connectionsRoster()

    return roster.agents.map(agent => ({ connectionId: agent.connectionId, profile: agent.profile }))
  }
}

/**
 * Pre-warm a route without opening a socket.
 *
 * Rate-limited because a plugin polling this would otherwise re-enumerate every
 * source on every call — and the roster's own per-source deadline is 10 s.
 */
export async function warmRegistryAgent(connectionId: string, profile: string): Promise<boolean> {
  const key = backendScopeKey(connectionId, profile)
  const last = lastWarm.get(key) ?? 0

  if (Date.now() - last < PREWARM_MIN_INTERVAL_MS) {
    return true
  }

  lastWarm.set(key, Date.now())

  const handle = await registryConnectionSource.ensureAgent(connectionId, profile)

  return handle.ok
}

setPluginConnectionSource(registryConnectionSource)
