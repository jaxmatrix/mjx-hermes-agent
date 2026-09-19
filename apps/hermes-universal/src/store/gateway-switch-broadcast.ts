import { broadcastToPeers, type PeerBroadcast } from '@/lib/webview-broadcast'
import type { GatewayMode } from '@/store/gateway-config'
import type { GatewayTarget } from '@/store/gateway-restore'

// The SEND half of cross-WebView gateway switching (the listener lives in
// store/gateway-switch-sync.ts). A leaf — it imports nothing but types and the
// broadcast leaf — so the store that switches can depend on it without reaching
// the listener, which imports that store.

export const SWITCH_EVENT = 'gateway://switched'

export interface GatewaySwitchedPayload extends PeerBroadcast {
  /** When the switch committed, on the sender's Lamport clock. With `origin` it
   *  orders two windows' crossed switches (`SwitchCommit`, store/connections). */
  at: number
  mode: GatewayMode
  /** The gateway to re-home onto: its registry row. Non-secret — the receiving
   *  side resolves it against Rust, which holds the credentials. */
  target: GatewayTarget
}

/**
 * Tell every other WebView that this one just moved to another gateway.
 *
 * Called by `selectConnection`, AFTER the preflight passed and the identity is
 * published (and by the owner's launch, when the launch mode moved the pointer) — the payload names a source known to be reachable, so
 * followers are not sent chasing a dial that just failed. Followers re-home
 * through `followConnection`, which does not re-broadcast, so the "don't echo
 * forever" guard is structural rather than a flag.
 */
export function broadcastGatewaySwitch(mode: GatewayMode, target: GatewayTarget, at: number): void {
  broadcastToPeers<GatewaySwitchedPayload>(SWITCH_EVENT, { at, mode, target })
}
