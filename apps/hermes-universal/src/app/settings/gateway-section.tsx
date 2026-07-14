import { CloudAgents } from '@/app/gateway/cloud-agents'
import { ModePicker } from '@/app/gateway/mode-picker'
import { Button } from '@/components/ui/button'
import { Globe } from '@/lib/icons'
import { useStore } from '@/store/atom'
import { $connection, $connectionPhase, disconnect, signOut } from '@/store/connection'
import { $gatewayMode } from '@/store/gateway-switch'

import { ListRow, SectionHeading, SettingsContent } from './primitives'

// Gateway settings (J10): manage the live connection from Settings — pick the
// mode, see the current connection, and disconnect or sign out. Complements the
// full-screen connect surface (shown only while disconnected). Plain English to
// match the mode-picker / cloud-agents chrome.

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

const PHASE_LABEL: Record<string, string> = {
  idle: 'Not connected',
  probing: 'Checking…',
  connecting: 'Connecting…',
  ready: 'Connected',
  error: 'Error',
}

export function GatewaySection() {
  const connection = useStore($connection)
  const phase = useStore($connectionPhase)
  const mode = useStore($gatewayMode)

  return (
    <SettingsContent>
      <SectionHeading icon={Globe} title="Mode" />
      <ModePicker />

      {connection && (
        <>
          <SectionHeading icon={Globe} title="Current connection" meta={PHASE_LABEL[phase] ?? phase} />
          <ListRow title="Backend" description={hostOf(connection.baseUrl)} />
          <ListRow title="Mode" description={connection.mode ?? 'remote'} />
          <ListRow title="Auth" description={connection.authMode} />
        </>
      )}

      {mode === 'cloud' && (
        <div className="pt-2">
          <SectionHeading icon={Globe} title="Cloud agents" />
          <CloudAgents />
        </div>
      )}

      {connection && (
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="outline" onClick={disconnect}>
            Disconnect
          </Button>
          <Button variant="destructive" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      )}
    </SettingsContent>
  )
}
