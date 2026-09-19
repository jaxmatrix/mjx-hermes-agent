import { translateNow } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { $activeConnection, $activeConnectionId } from '@/store/active-connection'
import { dropArtifactsForConnection } from '@/store/artifacts'
import { forgetBrowserForGatewaySwitch } from '@/store/browser'
import { resetChat } from '@/store/chat'
import { resetRepoStatusForBackendSwitch } from '@/store/coding-status'
import { $connection, beginGatewaySwitch, disconnect, endGatewaySwitch } from '@/store/connection'
import { type ClientHold, holdConnectionClient, releaseConnectionClient } from '@/store/connection-clients'
import { setCronJobs } from '@/store/cron'
import { closeGateway } from '@/store/gateway-client'
import type { Connection, GatewayMode } from '@/store/gateway-config'
import { dialSavedTarget, type GatewayTarget, loadGatewayTarget } from '@/store/gateway-restore'
import { closeAllSecondaries, releaseParkedTunnels } from '@/store/gateway-secondaries'
import { $gatewayMode, $gatewaySwitching } from '@/store/gateway-switch'
import { resetLiveRuntimeTracking } from '@/store/live-session-status'
import { resetLiveSync } from '@/store/live-sync'
import { stopLocalBackend } from '@/store/local-backend'
import { notify, notifyError } from '@/store/notifications'
import { closeAllPreviewTabs } from '@/store/preview'
import { $projectTree } from '@/store/project-scope'
import { resetPullRequestsForBackendSwitch } from '@/store/pull-requests'
import {
  $messagingSessions,
  $sessions,
  $sessionsLoading,
  $unreadFinishedSessionIds,
  sessionMatchesStoredId
} from '@/store/session'
import { $sessionKeyTabs, dropUnheldSessionStates, heldSessionKeys } from '@/store/session-key-states'
import {
  $activeStoredSessionId,
  $sessionSearch,
  $sessionsTotal,
  clearPinnedSessionCache,
  forgetLastSessionMarkers,
  refreshMessagingSessions,
  refreshSessions,
  resetSessionsPaging
} from '@/store/session-lifecycle'
import { resetSessionPinMirror } from '@/store/session-pin-sync'
import { resetArchivedSessionsForBackendSwitch } from '@/store/sidebar-archive'
import { disconnectSsh } from '@/store/ssh-backend'
import { resetSystemStatusForBackendSwitch } from '@/store/system-status'
import { clearTranscriptPaint } from '@/store/transcript-paint'
import { resetWorkspaceCwd } from '@/store/workspace-events'

// The soft gateway switch: re-home the running app onto another gateway in place.
// Split out of store/gateway-switch.ts (which only holds the persisted mode) because
// it reaches into the whole session/chat surface, while the mode store is imported
// from the boot-restore path — keeping this module out of that graph avoids a cycle.

/**
 * Clear gateway-bound UI state so a soft switch doesn't keep painting the previous
 * backend's rows.
 *
 * Sessions live in nanostores (not React Query) and `refreshSessions` only replaces
 * the list once it lands, so without an explicit wipe the sidebar shows the old
 * gateway's sessions until then. React Query caches go with them.
 *
 * Deliberately does NOT navigate or open a fresh chat: that would close route
 * overlays (Settings, the gateway popover) the user is standing in. Chat state is
 * cleared in place and the URL is left alone.
 *
 * Returns the secondaries' switch revision, for `releaseParkedTunnels`.
 */
/**
 * The tabs bound to the connection being left move from the ambient socket to
 * that connection's OWN client (MJXHRM-591, invariant 37).
 *
 * They were riding the app's socket because their connection was the active one;
 * it is about to be somebody else's. Holding the owning client here keeps their
 * runtime ids, their slices and their streams. A tab whose client cannot open
 * goes lost and keeps its ids for the replay path — the same outcome as any
 * other drop, and not this switch's business to decide.
 *
 * Tabs on every OTHER connection were never on the ambient socket, and are not
 * touched.
 */
let handOverHold: ClientHold | null = null

/** Give the hand-over's bridging hold back. The tab records keep their own. */
function releaseHandOverHold(): void {
  releaseConnectionClient(handOverHold)
  handOverHold = null
}

function handOverTabsToOwningClient(leaving: null | string): void {
  if (!leaving) {
    return
  }

  if (!$sessionKeyTabs.get().some(tile => tile.connectionId === leaving && !tile.unavailable)) {
    return
  }

  // `ambient: false`, explicitly (invariant 46): at this moment the leaving
  // connection is STILL the active one, so a client that asked the store would
  // short-circuit and hand these tabs nothing. The tab records already hold
  // their own client; this is the extra hold that keeps the socket up for the
  // window in which the ambient one is gone and the new one is not yet there —
  // it is given back on the next commit of the tab list.
  // Given back once the tab list commits again — the records' own holds carry
  // the connection from there.
  releaseConnectionClient(handOverHold)
  handOverHold = holdConnectionClient(leaving, { ambient: false })
}

export function wipeSessionListsForGatewaySwitch(leavingConnectionId?: null | string): number {
  // A switch touches only what it LEAVES (MJXHRM-591, invariant 37). Everything
  // below is either the active backend's own — its lists, its host's
  // filesystem, its status — or the ambient chat; a tab bound to any connection
  // keeps its slice, its runtime binding, its client and its place.
  const leaving = leavingConnectionId ?? $activeConnectionId.get()

  // Pins are mirrored per-backend. The next gateway has its own state.db and has
  // never seen them, so drop the "already pushed" bookkeeping and let the next
  // reconcile re-assert the whole set against the new backend — otherwise the
  // pins silently fail to reach it and its auto-archive sweep is free to hide
  // the conversations they protect.
  resetSessionPinMirror()
  // …and the cached pinned ROWS with it. `$sessions` being emptied is not
  // enough: the Pinned section falls back to this cache precisely so it survives
  // an empty list, so without the wipe it goes on rendering the PREVIOUS
  // gateway's conversations under the new one — rows the new backend has never
  // heard of and cannot open. The pin IDS deliberately stay (the durable flag on
  // each gateway re-asserts its own set, in both directions).
  clearPinnedSessionCache()
  $sessions.set([])
  $sessionsTotal.set(0)
  $sessionSearch.set([])
  $messagingSessions.set([])
  $unreadFinishedSessionIds.set([])
  setCronJobs([])
  // Only the LEAVING connection's slices, and only the ones no open tab holds.
  // The wipe used to be unconditional, which with bound tabs would take the
  // transcript of every tab on every other connection to answer a switch none
  // of them made — and the leaving connection's own tabs, which go on streaming
  // on its owning client.
  dropUnheldSessionStates(leaving)
  // …and the runtime bindings STAY. They used to be dropped because every id
  // belonged to the socket being torn down; a bound tab's ids belong to its own
  // connection's client, which this switch does not touch. The hand-over itself
  // happens later, in `softSwitchGateway`, where the ambient socket is already
  // closed and the new one is not yet up — see invariant 46.
  // The new gateway re-advertises `change_events` on its own gateway.ready. A
  // stale `true` would leave every consumer on its slow backstop against a
  // backend that never broadcasts (store/live-sync.ts).
  resetLiveSync()
  // The live-runtime ids the LEAVING connection's snapshot remembers belong to a
  // registry we are walking away from. Only that connection's, and no wipe of
  // the statuses themselves (Design v1.3, N4): a background tab's row is lit by
  // its OWN connection's snapshot, and clearing the lot would darken it to
  // answer a switch it had no part in.
  resetLiveRuntimeTracking(leaving)
  resetSessionsPaging()
  // Artifacts are keyed by sessions on the PREVIOUS backend, so both the
  // registry and any preview tab pointing into it go with them. Without this an
  // artifact tab survives the switch naming an id the new gateway has never
  // heard of, and re-opens as "artifact unavailable" — or worse, silently
  // collides with a same-shaped id over there.
  // …except the ones an open tab is still showing. The registry is keyed by the
  // scoped session key, so this drops the leaving connection's and nothing else.
  dropArtifactsForConnection(leaving, heldSessionKeys())

  // The tails STAY (MJXHRM-591). The wipe was here because "another backend can
  // recycle stored ids, so a cached tail from the previous one would paint
  // ANOTHER MACHINE'S conversation under a same-named id" — true of a cache
  // keyed by the bare id, and no longer true of one keyed by
  // `storedKeyFor(connection, profile, id)`: the two spellings cannot collide.
  // Keeping them is what lets a bound tab reopen instantly after a switch
  // instead of staring at a loader, and closes the loss half of the same
  // hazard. The painted copies go: a paint is a picture of a slice being
  // hydrated, and the slices this switch drops are not being hydrated by anyone.
  clearTranscriptPaint()
  // The remembered-chat marker still goes: setting `$activeStoredSessionId` to
  // null below does not clear it (the subscriber ignores null), so without this
  // the next boot opens backend A's id on backend B.
  forgetLastSessionMarkers(leaving)

  // BEFORE `resetChat`, which reads it. The project tree is the OLD gateway's
  // filesystem — `projects.tree` is a gateway RPC — and the sidebar only
  // re-pulls it on window focus or on entering the grouped view, so a switch
  // could leave it standing for a long time. Every path in it is absolute and
  // therefore not gateway-scoped, exactly like the repo-status caches below:
  // `/home/me/work` exists on both hosts and is a different repo on each. The
  // fresh chat `resetChat` is about to mint resolves its directory from this
  // tree (store/project-scope), so a stale one would create the first session on
  // the new gateway inside the old one's checkout.
  //
  // The SCOPE deliberately stays: it is where the user is standing, not the
  // backend's data. It re-resolves against the new tree when that lands, and
  // resolves to nothing in the meantime.
  $projectTree.set([])

  $activeStoredSessionId.set(null)
  resetChat()
  // The workspace root came from the old backend's filesystem.
  resetWorkspaceCwd()
  // …and so did every cached `git status`, worktree list and is-this-a-repo
  // verdict. Those are keyed by ABSOLUTE PATH, which is not gateway-scoped:
  // `/home/me/work` exists on both hosts and is a different repo on each, so
  // without this the coding rails paint the old gateway's branch and ± under the
  // new one's paths. The `gh` PR cache is the same story — it runs on the
  // gateway, keyed by the gateway's repo roots.
  resetRepoStatusForBackendSwitch()
  resetPullRequestsForBackendSwitch()
  // The Archived view is its own fetch against the old backend's session list,
  // and nothing else re-fetches it — without this it keeps showing the previous
  // gateway's archived rows until the user toggles the filter off and back on.
  resetArchivedSessionsForBackendSwitch()
  // …and so did every open preview tab. A preview reads and WRITES through
  // `/api/fs/*` on whichever gateway is current, so a surviving tab shows the
  // old backend's bytes over the new backend's path: hitting save either
  // recreates a file that only existed over there or overwrites a same-named
  // one here. The artifact half of this was already handled above
  // (`clearArtifactRegistry`); file tabs were the half that wasn't.
  closeAllPreviewTabs()

  // The statusbar's gateway health, inference readiness and backend VERSION all
  // came from the previous backend, and `system-status.ts` only re-polls every
  // 30 s behind a `$gatewayState === 'open'` guard — so without this the new
  // gateway is described by the old one's numbers until the next tick (D-1).
  resetSystemStatusForBackendSwitch()
  // A registered source's credentials are attached per BASE URL in Rust, so the
  // secondaries opened against the source we are leaving have to go with it.
  const secondariesRevision = closeAllSecondaries()
  // And the in-app browser (MJXHRM-447): a browsed `localhost:5173` names the
  // OLD machine, and the SSH forward lease behind it is a tunnel into a host we
  // have stopped talking to. A new host never inherits a tunnel into the old
  // one (rule 20).
  forgetBrowserForGatewaySwitch()

  // Sidebar skeletons until refreshSessions lands.
  $sessionsLoading.set(true)
  // Blunt, matching the profile-swap precedent in store/profiles.ts: universal has
  // no gateway-scoped key partition, so everything cached is re-fetched.
  void queryClient.invalidateQueries()

  return secondariesRevision
}

/**
 * True when `storedSessionId` is absent from the session list currently loaded.
 *
 * Call only once the new gateway's list has landed — an empty list mid-refresh
 * would read as "everything is missing".
 */
export function sessionMissingFromCurrentGateway(storedSessionId: string): boolean {
  return !$sessions.get().some(session => sessionMatchesStoredId(session, storedSessionId))
}

/**
 * Tell the user their chat did not come across, once the new gateway's list is in.
 *
 * The wipe has already reset the chat and cleared the active id, so every surface
 * is sitting on a fresh session by this point — what is missing is the reason why,
 * which otherwise reads as the app having silently dropped their conversation.
 * Sessions are per-backend, so a chat existing on both gateways is the exception.
 */
function warnIfSessionMissingAfterSwitch(previousSessionId: null | string): void {
  if (!previousSessionId || !sessionMissingFromCurrentGateway(previousSessionId)) {
    return
  }

  notify({
    kind: 'warning',
    title: translateNow('settings.gateway.sessionMissingTitle'),
    message: translateNow('settings.gateway.sessionMissingMessage')
  })
}

/**
 * Recover from a switch whose dial failed.
 *
 * Rolls back onto the gateway we came from when there is one, leaving the user where
 * they started with an error rather than nowhere. Otherwise — a first-ever connect,
 * or a rollback that fails in turn — `disconnect()` clears `$hasConnected`, which is
 * what drops the root gate to the connect screen (see mobile-controller).
 *
 * Runs INSIDE the switch, before `$gatewaySwitching` is released, so the shell holds
 * its mounted state across the recovery instead of flashing the connecting screen.
 */
async function rollbackFailedSwitch(
  cause: unknown,
  previous: Connection | null,
  previousTarget: GatewayTarget | null
): Promise<void> {
  if (!previous || !previousTarget) {
    disconnect()

    return
  }

  try {
    // Non-interactive: the user is already looking at one failure; a rollback must
    // not raise a fresh SSH passphrase / host-key prompt on top of it.
    await dialSavedTarget(previousTarget)
    // The lists were wiped for a switch that never happened — refill them.
    await Promise.all([refreshSessions().catch(() => {}), refreshMessagingSessions().catch(() => {})])
    // Titled for what the user attempted; the body carries why it failed.
    notifyError(cause, translateNow('settings.gateway.switchFailed'))
  } catch {
    // Nothing left to stand on: the old gateway is gone too.
    disconnect()
  }
}

/**
 * Soft gateway switch: wipe → drop the socket → re-dial IN PLACE.
 *
 * Never calls `disconnect()`: that clears `$hasConnected` and drops the root gate to
 * the connect picker. Here `$hasConnected` stays latched and `$gatewaySwitching`
 * gates the root gates, while begin/endGatewaySwitch stands the reconnect supervisor
 * down — so the shell, Settings and the gateway popover all stay mounted across the
 * swap.
 *
 * A FAILED dial does not leave the app stranded. The wipe and `closeGateway()` both
 * happen before the dial, so without recovery a failure means an emptied list and a
 * dead socket — easy to hit, since an SSH dial runs 45-90s and can fail on host key,
 * passphrase or timeout. So on failure we roll back onto the gateway we came from
 * (`dialSavedTarget`, which also restores `$gatewayMode`), and fall back to
 * `disconnect()` — the home / connect-picker path — when there is nothing to roll
 * back to, or when the rollback dial fails too.
 *
 * Re-throws whatever `dial` threw either way, so the caller still surfaces its
 * failure toast; `$connectionError` is set by the connect* helpers.
 */
export async function softSwitchGateway(mode: GatewayMode, dial: () => Promise<void>): Promise<void> {
  // Snapshot the gateway we are leaving BEFORE anything tears it down: `dial` writes
  // $connection itself, and a connect* only persists its target once it has succeeded,
  // so after this point neither is still the old one.
  const previous = $connection.get()
  // The connection we are LEAVING, captured before any teardown: the hand-over
  // names it rather than asking the store, which by then answers about B.
  const previousConnectionId = $activeConnectionId.get()
  const previousTarget = loadGatewayTarget()
  // The wipe nulls this, so grab it first: it is what tells us, once the new
  // gateway's list has landed, whether the chat the user was on came across.
  const previousSessionId = $activeStoredSessionId.get()

  $gatewaySwitching.set(true)
  beginGatewaySwitch()
  const secondariesRevision = wipeSessionListsForGatewaySwitch($activeConnectionId.get())

  try {
    // Leaving a local or SSH backend releases the ACTIVE hold only: a background
    // tunnel lease keeps it up, and nothing else does (MJXHRM-592). SSH used to
    // release nothing, so its tunnel leaked until the same scope was dialled.
    const leaving = $connection.get()

    if (leaving?.mode === 'local') {
      await stopLocalBackend().catch(() => {})
    }

    if (leaving?.mode === 'ssh') {
      await disconnectSsh(leaving.profile ?? null, $activeConnection.get()?.dialConnectionId ?? null).catch(() => {})
    }

    closeGateway()
    // THE HAND-OVER (invariant 46), here and not in the wipe: A's ambient socket
    // is gone and B is not yet active, which is the one window where "the tabs
    // on A move to A's own client" is unambiguous. It names A explicitly —
    // captured in `previous` before any teardown — so it is correct whatever the
    // store says about who is active.
    handOverTabsToOwningClient(previousConnectionId)
    $gatewayMode.set(mode)
    await dial()
    // B is up and A's tabs are carried by their own records now: the extra hold
    // the hand-over took for the gap is given back.
    releaseHandOverHold()
    // Universal doesn't refresh session lists on gateway open, so the switch does it.
    let listed = true
    await Promise.all([
      refreshSessions().catch(() => {
        listed = false
      }),
      refreshMessagingSessions().catch(() => {})
    ])

    // Only when the list actually landed: a failed refresh leaves it empty, which
    // is indistinguishable from "the new gateway has none" and would make us claim
    // the user's session is gone on nothing more than a dropped request.
    if (listed) {
      warnIfSessionMissingAfterSwitch(previousSessionId)
    }
  } catch (err) {
    await rollbackFailedSwitch(err, previous, previousTarget)

    throw err
  } finally {
    // After the dial: a tunnel the new connection now holds as primary survives.
    // This switch's own revision: a newer switch still in flight keeps its holds.
    releaseParkedTunnels(secondariesRevision)
    $sessionsLoading.set(false)
    // Imperative guard down before the reactive one, so the root gates never un-gate
    // while the reconnect supervisor is still suspended.
    endGatewaySwitch()
    $gatewaySwitching.set(false)
  }
}
