import { IS_TAURI } from '@/lib/platform'
import { onPeerBroadcast } from '@/lib/webview-broadcast'
import { followConnection } from '@/store/connections'
import { type GatewaySwitchedPayload, SWITCH_EVENT } from '@/store/gateway-switch-broadcast'

// Cross-WebView gateway switching.
//
// Every WebView the app opens — the main shell, an Android native activity screen
// (`?win=activity`), a desktop pop-out (`?win=secondary`) — boots src/main.tsx and
// runs its OWN fold over its own primary socket, answered by its own bridge from
// its own `$activeConnection`. Without this module a switch driven from one
// surface leaves every other surface quietly talking to the OLD backend.
//
// So the initiator broadcasts (store/gateway-switch-broadcast.ts — the send half
// lives in its own leaf module), and every other WebView re-homes onto the same
// source here. The listener is wired by a side-effect import in boot.ts.

let started = false

/**
 * Listen for another WebView's switch and re-home this one onto the same source.
 *
 * Idempotent — boot.ts imports this for its side effect, and a re-import (HMR,
 * a test) must not stack listeners.
 *
 * The re-home is `followConnection`: this window's identity moves and its own
 * boot hook soft-switches — the wipe, the `$gatewaySwitching` gate that keeps
 * the shell mounted, and the re-dial through the bridge. Never interactive: the
 * user answered any prompt on the initiating surface.
 */
export function initGatewaySwitchSync(): void {
  if (started || !IS_TAURI) {
    return
  }

  started = true

  // `onPeerBroadcast` has already dropped our own echo (`emit` is global).
  onPeerBroadcast<GatewaySwitchedPayload>(SWITCH_EVENT, payload => {
    // Anything without a source goes. Every switch names its registry row
    // (MJXHRM-446); a payload that does not is malformed, and acting on it would
    // move this WebView nowhere in particular.
    const connectionId = payload.target?.connectionId

    if (!connectionId || !Number.isFinite(payload.at)) {
      return
    }

    // The stamp decides a crossed pair: see `SwitchCommit`.
    void followConnection(connectionId, { at: payload.at, origin: payload.origin }).catch(() => {
      // The initiator owns the user-facing error; this window stays where it is.
    })
  })
}

initGatewaySwitchSync()
