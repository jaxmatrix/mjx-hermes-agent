import { useStore } from '@nanostores/react'

import { ModelVisibilityDialog } from '@/components/model-visibility-dialog'
import { $sessionId } from '@/store/chat'
import { getGatewayClient } from '@/store/gateway-client'
import { $modelVisibilityOpen, setModelVisibilityOpen } from '@/store/model-visibility'
import { $activeGatewayProfile } from '@/store/profile'
import { $gatewayState } from '@/store/session'

interface ModelVisibilityOverlayProps {
  /** Omitted by a host with no provider-setup surface to hand off to (the
   *  satellite chat window), which stands the "Add provider…" row down. */
  onOpenProviders?: () => void
}

export function ModelVisibilityOverlay({ onOpenProviders }: ModelVisibilityOverlayProps) {
  const sessionId = useStore($sessionId)
  const profile = useStore($activeGatewayProfile)
  const gatewayOpen = useStore($gatewayState) === 'open'
  const open = useStore($modelVisibilityOpen)

  if (!gatewayOpen) {
    return null
  }

  return (
    <ModelVisibilityDialog
      gw={getGatewayClient() ?? undefined}
      onOpenChange={setModelVisibilityOpen}
      onOpenProviders={onOpenProviders ?? (() => {})}
      open={open}
      profile={profile}
      sessionId={sessionId}
    />
  )
}
