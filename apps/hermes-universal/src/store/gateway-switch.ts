import { type Codec, persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'
import { disconnect } from '@/store/connection'
import type { GatewayMode } from '@/store/gateway-config'

// Gateway-mode switching (E1). The app talks to a backend in one of three modes —
// local (spawned), remote (URL), cloud (portal-discovered). This holds the chosen
// mode (persisted). Two ways to change it:
//   • setGatewayMode — mode-only, no teardown. Used when *reconfiguring* an
//     already-connected app inside Settings → Gateway (desktop parity: picking a
//     mode card is a pending selection; connecting is a separate explicit action).
//   • switchGatewayMode — mode + tear down the live connection, for a hard reset.

const modeCodec: Codec<GatewayMode> = {
  decode: raw => (raw === 'local' || raw === 'cloud' ? raw : 'remote'),
  encode: value => value,
}

/** The last-selected gateway mode; persisted so the app reopens into it. */
export const $gatewayMode = persistentAtom<GatewayMode>('hermes.gateway.mode', 'remote', modeCodec)

/** True while a switch is tearing down the old connection — lets the UI show a
 *  switching state and suppress the ordinary disconnect feedback. */
export const $gatewaySwitching = atom(false)

/** Set the gateway mode WITHOUT touching the live connection (pending selection).
 *  Reconfiguring an already-connected app inside Settings uses this — the root gate
 *  keeps Settings mounted across the subsequent reconnect (it reads $hasConnected),
 *  so no full-screen bounce. Connecting is a separate, explicit action. */
export function setGatewayMode(mode: GatewayMode): void {
  $gatewayMode.set(mode)
}

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
