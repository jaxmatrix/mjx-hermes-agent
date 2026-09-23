/**
 * The union roster — every profile on every registered source — and the
 * credential-free routes plugins dial by.
 *
 * Rust enumerates (`connections_roster`, `connections/roster.rs`) under the same
 * three rules Electron's does: every source races its own deadline, an SSH
 * source is never dialled from a poll (it is SEEDED with its one profile and
 * reports `connect-on-demand`), and an unreachable source contributes nothing.
 * So this is a join: Rust's rows carry ids, and desktop's carry each source's
 * kind and label too, which come from the registry view.
 *
 * Every backend here is the unified server — the profile is named per request —
 * so a route's `targetProfile` is its `profile` (Electron rewrites it only for
 * an SSH serve launched under one fixed profile, which universal never does).
 *
 * A source's `error` is passed on only when it is one of Rust's tokens: a
 * transport failure's text quotes the address.
 */

import type { DesktopAgentRoster, DesktopPluginProfileRoute } from '@/global'
import type { ConnectionView } from '@/store/connections'

type Bridge = NonNullable<typeof window.hermesDesktop>

const SOURCE_ERRORS = new Set(['connect-on-demand', 'not-running', 'timeout'])

export function sourceError(error: string | undefined): string | undefined {
  if (!error) {
    return undefined
  }

  return SOURCE_ERRORS.has(error) || /^HTTP \d{3}$/.test(error) ? error : 'unreachable'
}

const profileName = (value: unknown): string => (typeof value === 'string' ? value.trim() : '') || 'default'

async function enumerate(): Promise<{
  agents: { connectionId: string; handle: string; profile: string }[]
  rows: Map<string, ConnectionView>
  sources: { connectionId: string; error?: string; ok: boolean }[]
}> {
  // Dynamic: the registry store reaches `@/hermes`.
  const { $registryView, connectionsRoster, refreshConnections } = await import('@/store/connections')

  const [roster, view] = await Promise.all([
    connectionsRoster(),
    // Read, not refreshed: a refresh re-publishes the registry to every listener,
    // and desktop asks for the roster on every focus.
    $registryView.get().connections.length ? $registryView.get() : refreshConnections()
  ])

  return {
    agents: roster.agents,
    rows: new Map(view.connections.map(row => [row.id, row])),
    sources: roster.sources
  }
}

export const rosterBridge: Required<Pick<Bridge, 'getAgentRoster'>> & Pick<Bridge, 'getProfileRoutes'> = {
  getAgentRoster: async (): Promise<DesktopAgentRoster> => {
    const { agents, rows, sources } = await enumerate()

    return {
      // A row removed between the two reads has nothing to be routed to.
      agents: agents.flatMap(agent => {
        const row = rows.get(agent.connectionId)

        return row
          ? [
              {
                connectionId: row.id,
                connectionKind: row.kind,
                connectionLabel: row.label,
                handle: agent.handle,
                profile: agent.profile
              }
            ]
          : []
      }),
      sources: sources.flatMap(source => {
        const row = rows.get(source.connectionId)
        const error = sourceError(source.error)

        return row
          ? [{ connectionId: row.id, kind: row.kind, label: row.label, reachable: source.ok, ...(error && { error }) }]
          : []
      })
    }
  },

  getProfileRoutes: async profiles => {
    const { agents, rows, sources } = await enumerate()
    const seen = new Set<string>()
    const routes: DesktopPluginProfileRoute[] = []

    const add = (row: ConnectionView, name: string) => {
      const profile = profileName(name)
      const key = `${row.id}\0${profile}`

      if (!seen.has(key)) {
        seen.add(key)
        routes.push({
          connectionId: row.id,
          mode: row.kind === 'local' ? 'local' : 'remote',
          profile,
          targetProfile: profile
        })
      }
    }

    for (const agent of agents) {
      const row = rows.get(agent.connectionId)

      if (row) {
        add(row, agent.profile)
      }
    }

    // Electron's fallback: a local enumeration that FAILED must not take the
    // caller's cached local profile names with it.
    const local = [...rows.values()].find(row => row.kind === 'local')
    const failure = local ? sources.find(source => source.connectionId === local.id)?.error : undefined

    if (local && failure && failure !== 'connect-on-demand') {
      for (const name of Array.isArray(profiles) ? profiles.slice(0, 256) : []) {
        if (typeof name === 'string' && name.trim()) {
          add(local, name)
        }
      }
    }

    return routes
  }
}
