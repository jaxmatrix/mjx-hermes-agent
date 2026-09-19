/**
 * WHAT A TAB CAN SAY ABOUT ITS BACKEND — the one answer both hosts render
 * (MJXHRM-591, invariants 39 and 40).
 *
 * A tab bound to a background connection has two failure modes the app has
 * never had to show before, and they are not the same thing:
 *
 *  * LOST — the connection is the tab's, and it is down. The transcript is
 *    still true, the tab still owns its session, and the client is climbing
 *    back (or waiting for the user, when retrying cannot fix it). The chat
 *    takes a red inner border and an error box across the bottom with Retry.
 *  * UNAVAILABLE — the backend behind the tab CHANGED, or was never reachable
 *    from this device. Nothing here can be resumed, retried or reopened,
 *    because the conversation this tab names lives somewhere that is no longer
 *    there: the only honest verb is Close (invariant 38).
 *
 * The distinction is the whole point. "Lost" invites you to wait; "unavailable"
 * tells you the tab is finished. Offering Retry on the second one would ask the
 * user to keep pulling a lever that cannot do anything.
 *
 * Pure: the inputs are passed in, so the rule is unit-testable and both the
 * desktop tile and the mobile chat read the same answer.
 */

import { IS_MOBILE } from '@/lib/platform'
import type { ConnectionClientState } from '@/store/connection-clients'
import type { SessionTile } from '@/store/session-key-states'
import { LOCAL_SESSION_SCOPE } from '@/store/session-state-types'

export type TabConnection =
  | { kind: 'ok' }
  | { connectionId: string; error?: string; kind: 'lost'; terminal: boolean }
  | { kind: 'unavailable'; reason: 'backend-changed' | 'unsupported-platform' }

const OK: TabConnection = { kind: 'ok' }

/**
 * Can a tab bound here run on THIS device at all?
 *
 * The local connection is `unsupported_platform` on Android and iOS (592):
 * there is no child process to spawn, so a tab naming it opens straight into
 * unavailable rather than dialling something that cannot exist and reporting a
 * transport error a minute later.
 */
export function tabIsUnsupportedHere(connectionId: null | string | undefined): boolean {
  return IS_MOBILE && (connectionId ?? LOCAL_SESSION_SCOPE) === LOCAL_SESSION_SCOPE
}

/**
 * What the surfaces for this tab should show.
 *
 * `tile` is the tab's own record when there is one — a mobile chat opened from
 * a row has a ref but no tile, and answers from the ref alone. `client` is the
 * owning client's phase; a tab on the ACTIVE connection has none, because it
 * rides the ambient socket whose state the app already shows everywhere else.
 */
export function tabConnectionFor(input: {
  /** Whether this tab is on the connection the app itself is pointed at. */
  ambient?: boolean
  client?: ConnectionClientState | undefined
  connectionId: null | string | undefined
  tile?: Pick<SessionTile, 'unavailable'> | undefined
}): TabConnection {
  if (input.tile?.unavailable) {
    return { kind: 'unavailable', reason: 'backend-changed' }
  }

  if (tabIsUnsupportedHere(input.connectionId)) {
    return { kind: 'unavailable', reason: 'unsupported-platform' }
  }

  const client = input.client

  if (client?.phase === 'live' || client?.phase === 'opening') {
    return OK
  }

  // A tab on the ACTIVE connection rides the ambient socket, whose state the
  // app already shows everywhere else — it has no hold, and that is correct.
  // Any OTHER connection with no hold is not connected, and the banner says so
  // rather than claiming health it cannot vouch for (invariant 46): a missing
  // hold used to read as `ok`, which is exactly the tab that looks fine and
  // cannot send.
  if (!client && input.ambient !== false) {
    return OK
  }

  return {
    connectionId: input.connectionId ?? LOCAL_SESSION_SCOPE,
    error: client?.error,
    kind: 'lost',
    terminal: Boolean(client?.terminal)
  }
}

/** Whether the chat should wear the red inner border. */
export const tabIsBroken = (state: TabConnection): boolean => state.kind !== 'ok'
