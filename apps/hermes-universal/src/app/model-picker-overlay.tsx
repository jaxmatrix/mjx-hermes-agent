import { useStore } from '@nanostores/react'

import { ModelPickerDialog } from '@/components/model-picker'
import { useStoreSelector } from '@/lib/use-session-slice'
import { $sessionId } from '@/store/chat'
import { getGatewayClient } from '@/store/gateway-client'
import { $currentModel, $currentProvider, $modelPickerOpen, selectModel, setModelPickerOpen } from '@/store/model'
import { $activeGatewayProfile } from '@/store/profile'
import { $gatewayState } from '@/store/session'
import { $activeSessionKey } from '@/store/session-state-types'
import { $focusedRuntimeId, $focusedSessionState } from '@/store/session-states'

interface ModelPickerOverlayProps {
  /** Omitted by a host with no provider-setup surface to hand off to (the
   *  satellite chat window), which stands the footer's "Add provider" down. */
  onOpenProviders?: () => void
}

// Mount point for the full model picker — the ⌘⇧M surface, and the composer
// pill's fallback when the gateway is closed and no live dropdown exists.
export function ModelPickerOverlay({ onOpenProviders }: ModelPickerOverlayProps) {
  const primarySessionId = useStore($sessionId)
  const primaryModel = useStore($currentModel)
  const primaryProvider = useStore($currentProvider)
  const activeSessionKey = useStore($activeSessionKey)
  const focusedRuntimeId = useStore($focusedRuntimeId)
  const focusedModel = useStoreSelector($focusedSessionState, state => state?.model ?? null)
  const focusedProvider = useStoreSelector($focusedSessionState, state => state?.provider ?? null)
  const profile = useStore($activeGatewayProfile)
  const gatewayOpen = useStore($gatewayState) === 'open'
  const open = useStore($modelPickerOpen)

  const targetsTile = Boolean(focusedRuntimeId) && focusedRuntimeId !== activeSessionKey

  const sessionId = targetsTile ? focusedRuntimeId : primarySessionId
  const currentModel = targetsTile && focusedModel ? focusedModel : primaryModel
  const currentProvider = targetsTile && focusedProvider ? focusedProvider : primaryProvider

  if (!gatewayOpen) {
    return null
  }

  return (
    <ModelPickerDialog
      currentModel={currentModel}
      currentProvider={currentProvider}
      gw={getGatewayClient() ?? undefined}
      onOpenChange={setModelPickerOpen}
      onSelect={selection => void selectModel({ ...selection, sessionId })}
      open={open}
      profile={profile}
      sessionId={sessionId}
    />
  )
}
