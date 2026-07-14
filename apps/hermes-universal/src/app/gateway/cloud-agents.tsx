import { useEffect } from 'react'

import { Circle } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $cloudAgents,
  $cloudConnectingId,
  $cloudDiscover,
  $cloudError,
  $cloudOrg,
  $cloudOrgs,
  $portalSignedIn,
  type CloudAgent,
  cloudSignIn,
  connectCloudAgent,
  refreshCloud,
  selectCloudOrg,
} from '@/store/cloud'

// Cloud agents surface (E5): sign in to the Nous portal, list discovered agents,
// and connect (silent per-agent SSO → cloud/oauth connect). Mirrors the desktop
// gateway-settings cloud panel, trimmed to the mobile-first list.

const gatewayDotColor: Record<string, string> = {
  active: 'text-green-500',
  degraded: 'text-yellow-500',
  down: 'text-red-500',
  unknown: 'text-muted-foreground',
}

function AgentRow({ agent }: { agent: CloudAgent }) {
  const connectingId = useStore($cloudConnectingId)
  const connecting = connectingId === agent.id
  const disabled = !agent.dashboardUrl || connectingId !== null

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
      <Circle size={10} className={cn('shrink-0', gatewayDotColor[agent.dashboardGatewayState] ?? gatewayDotColor.unknown)} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{agent.name || agent.id}</div>
        <div className="truncate text-xs text-muted-foreground">{agent.status}</div>
      </div>
      <button
        className="btn btn-primary shrink-0 px-3 py-1 text-sm"
        disabled={disabled}
        onClick={() => void connectCloudAgent(agent)}
      >
        {connecting ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  )
}

export function CloudAgents() {
  const signedIn = useStore($portalSignedIn)
  const agents = useStore($cloudAgents)
  const orgs = useStore($cloudOrgs)
  const org = useStore($cloudOrg)
  const discover = useStore($cloudDiscover)
  const error = useStore($cloudError)

  useEffect(() => {
    void refreshCloud()
  }, [])

  if (!signedIn) {
    return (
      <div className="flex flex-col gap-2">
        <p className="connect-sub">Sign in to the Nous portal to see your agents.</p>
        {error && <div className="error-line">{error}</div>}
        <button className="btn btn-primary" onClick={() => void cloudSignIn()}>
          Sign in to Nous
        </button>
      </div>
    )
  }

  // Multi-org account: pick an org before listing agents.
  if (orgs.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="connect-sub">Choose an organization.</p>
        {error && <div className="error-line">{error}</div>}
        {orgs.map(o => (
          <button
            key={o.id}
            className="rounded-lg border border-border p-3 text-left text-sm hover:bg-accent"
            onClick={() => void selectCloudOrg(o)}
          >
            <span className="font-medium">{o.name}</span>
            {o.isPersonal && <span className="ml-2 text-xs text-muted-foreground">Personal</span>}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {org && <p className="connect-sub">Agents in {org.name}.</p>}
      {error && <div className="error-line">{error}</div>}
      {discover === 'loading' && <p className="text-sm text-muted-foreground">Loading agents…</p>}
      {discover === 'done' && agents.length === 0 && (
        <p className="text-sm text-muted-foreground">No agents found for this account.</p>
      )}
      {agents.map(a => (
        <AgentRow key={a.id} agent={a} />
      ))}
    </div>
  )
}
