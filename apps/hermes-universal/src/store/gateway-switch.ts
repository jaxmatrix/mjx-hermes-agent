import { type Codec, persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'
import { disconnect } from '@/store/connection'
import type { GatewayMode } from '@/store/gateway-config'

// Gateway-mode switching (E1). The app talks to a backend in one of three modes —
// local (spawned), remote (URL), cloud (portal-discovered). This holds the chosen
// mode (persisted) and tears down the live connection when it changes so each
// mode's own connect surface (mode-picker / connect-screen / cloud-agents) can
// dial the new backend cleanly.

const modeCodec: Codec<GatewayMode> = {
  decode: raw => (raw === 'local' || raw === 'cloud' ? raw : 'remote'),
  encode: value => value,
}

/** The last-selected gateway mode; persisted so the app reopens into it. */
export const $gatewayMode = persistentAtom<GatewayMode>('hermes.gateway.mode', 'remote', modeCodec)

/** True while a switch is tearing down the old connection — lets the UI show a
 *  switching state and suppress the ordinary disconnect feedback. */
export const $gatewaySwitching = atom(false)

/** Switch gateway mode: drop the live connection so the target mode's connect flow
 *  can start fresh. No-op when already in `mode`. */
export function switchGatewayMode(mode: GatewayMode): void {
  if ($gatewayMode.get() === mode) return
  $gatewaySwitching.set(true)
  try {
    disconnect()
    $gatewayMode.set(mode)
  } finally {
    $gatewaySwitching.set(false)
  }
}
