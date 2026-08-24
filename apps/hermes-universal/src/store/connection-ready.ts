import { computed } from '@/store/atom'

import { $activeConnection } from './active-connection'
import { $connection, $connectionPhase, $hasConnected } from './connection-atoms'
import { $gatewayState } from './gateway'
import { $restoring } from './gateway-restore'
import { $gatewaySwitching } from './gateway-switch'

/**
 * "Is the app usable right now?" — the ONE derived answer to a question six
 * atoms each answer a sixth of.
 *
 * Rule 12 forbids a seventh FLAG, not a derivation: nothing writes this, it is
 * a `computed` over the six that already exist, so it cannot drift from them the
 * way a maintained boolean would. Every surface that used to compose these by
 * hand — and every plugin, through `host.state.ready` — reads the same answer.
 *
 * The six, and why each is necessary rather than merely available:
 *  • `$connection`        — there is a backend to talk to at all;
 *  • `$connectionPhase`   — the PROBE settled (a `probing`/`connecting` gateway
 *                           has a descriptor but no agreed contract yet);
 *  • `$gatewayState`      — the socket is actually open, which is what carries
 *                           every RPC;
 *  • `$hasConnected`      — a live connection was reached this session, so a
 *                           momentary socket blip reads as "reconnecting"
 *                           rather than "never connected";
 *  • `$gatewaySwitching`  — a switch is mid-flight and the old answers are
 *                           about to stop being true;
 *  • `$restoring`         — the boot restore has not finished choosing a
 *                           backend, so `idle` does not yet mean "no gateway".
 *
 * Deliberately conservative: it is false while ANY of the transitional flags is
 * up. A caller that wants "is this the picker or a blip" composes the flags
 * itself — this atom exists for the far more common question, which is whether
 * it is safe to fire an RPC.
 *
 * MJXHRM-446 added `$activeConnection` as a seventh INPUT here rather than
 * minting a second derivation elsewhere (reconciliation C3). It is an input, not
 * a flag: with a registry, "there is a descriptor" and "we know WHICH source it
 * is" are different facts, and an RPC fired between them lands on whichever
 * backend the previous source's atoms still describe. `publishActiveConnection`
 * writes both in one `batch()`, so this can never observe them half-applied.
 */
export const $connectionReady = computed(
  [$activeConnection, $connection, $connectionPhase, $gatewayState, $hasConnected, $gatewaySwitching, $restoring],
  (active, connection, phase, socket, hasConnected, switching, restoring) =>
    Boolean(active) &&
    Boolean(connection) &&
    hasConnected &&
    phase === 'ready' &&
    socket === 'open' &&
    !switching &&
    !restoring
)
