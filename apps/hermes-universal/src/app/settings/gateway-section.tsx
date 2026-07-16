import { GatewayConfigurator } from '@/app/gateway/gateway-configurator'

import { SettingsContent } from './primitives'

// Settings → Gateway. The whole mode-grid + connect surface lives in the shared
// GatewayConfigurator (reused by the first-run connect screen), so Settings and
// first-run stay pixel-identical — the desktop pattern of one component for both.
// This wrapper just supplies the settings page's scroll container.
export function GatewaySection() {
  return (
    <SettingsContent>
      <GatewayConfigurator variant="settings" />
    </SettingsContent>
  )
}
