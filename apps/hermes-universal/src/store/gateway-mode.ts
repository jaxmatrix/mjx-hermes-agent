import { type Codec, persistentAtom } from '@/lib/persisted'
import type { GatewayMode } from '@/store/gateway-config'

// Which kind of backend the app talks to — local (spawned), remote (URL), cloud
// (portal-discovered), ssh (tunnelled). Persisted so the connect surface reopens
// on the card the user last chose. `publishActiveConnection` moves it with the
// identity; `setGatewayMode` is the pending choice ("Save for next restart").
//
// Universal's own: desktop keeps the mode in Electron's connection config, and
// its `store/gateway-switch.ts` — which this used to share a file with — is the
// switch barrier only.

// A whitelist, so a corrupt or future value degrades to the safest mode rather
// than being trusted. Every new mode MUST be added here: a missing entry does not
// fail loudly, it silently reopens the app in 'remote'.
const modeCodec: Codec<GatewayMode> = {
  decode: raw => (raw === 'local' || raw === 'cloud' || raw === 'ssh' ? raw : 'remote'),
  encode: value => value
}

/** The last-selected gateway mode; persisted so the app reopens into it. */
export const $gatewayMode = persistentAtom<GatewayMode>('hermes.gateway.mode', 'remote', modeCodec)

/** Set the gateway mode WITHOUT touching the live connection (pending selection). */
export function setGatewayMode(mode: GatewayMode): void {
  $gatewayMode.set(mode)
}
