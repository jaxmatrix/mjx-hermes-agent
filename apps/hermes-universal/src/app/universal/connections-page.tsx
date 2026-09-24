/**
 * Universal's Gateways page, as a page of desktop's workspace.
 *
 * Desktop's Settings → Gateway edits what desktop's model knows: a URL, a
 * token, an SSH host and key path. Universal's sources carry more than its form
 * can hold — a pasted private key, a passphrase or password kept in the OS
 * credential store, the host-key and sign-in questions a dial asks, a remote
 * Hermes install — and those editors are universal's own. They mount here
 * untouched: the registry list and editor (`settings/connections`), and inside
 * it the gateway configurator with its SSH panel, install offer and cloud
 * picker (`app/gateway`). Above them, the tunnels behind this window's sources.
 */

import { ConnectionsSection } from '@/app/settings/connections'
import { useI18n } from '@/i18n'

import { TunnelStatusList } from './tunnel-status'

export default function ConnectionsPage() {
  const { t } = useI18n()

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="universal-connections-page">
      <header className="shrink-0 px-5 pt-4">
        <h1 className="mb-2 text-base font-semibold">{t.settings.connections.managePage}</h1>
        <TunnelStatusList />
      </header>
      <div className="grid min-h-0 flex-1">
        <ConnectionsSection />
      </div>
    </div>
  )
}
