import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/connection', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $connection: atom<unknown>(null),
    beginGatewaySwitch: vi.fn(),
    endGatewaySwitch: vi.fn(),
    // Present so a regression that reintroduces the hard reset is caught below.
    disconnect: vi.fn()
  }
})
vi.mock('@/store/gateway-client', () => ({ closeGateway: vi.fn() }))
vi.mock('@/store/gateway-restore', () => ({
  dialSavedTarget: vi.fn().mockResolvedValue(undefined),
  loadGatewayTarget: vi.fn().mockReturnValue(null)
}))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/local-backend', () => ({
  killLocalBackend: vi.fn().mockResolvedValue(undefined),
  stopLocalBackend: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/store/ssh-backend', () => ({ disconnectSsh: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/store/gateway-secondaries', () => ({ closeAllSecondaries: vi.fn(() => 7), releaseParkedTunnels: vi.fn() }))
vi.mock('@/store/chat', () => ({ resetChat: vi.fn() }))
vi.mock('@/store/cron', () => ({ setCronJobs: vi.fn() }))
vi.mock('@/store/workspace-events', () => ({ resetWorkspaceCwd: vi.fn() }))
// MJXHRM-591 B2: NOT mocked. Review 1 named the wholesale mock here as the
// reason a broken hand-over passed — it asserted that a function was called,
// which is true of a hand-over that hands over nothing. The real module runs
// over a fake secondary (the `@/store/gateway-secondaries` mock below), so the
// assertion is that A's frames land in A's slice after the switch.
vi.mock('@/store/gateway-secondaries', async importActual => {
  const actual = await importActual<Record<string, unknown>>()

  return {
    ...actual,
    closeAllSecondaries: vi.fn(actual.closeAllSecondaries as () => number),
    leaseSecondary: vi.fn(async (_scopeKey: string, connectionId: string) => ({
      connectionId,
      request: vi.fn(),
      scopeKey: _scopeKey
    })),
    pinSecondary: vi.fn(),
    releaseParkedTunnels: vi.fn(actual.releaseParkedTunnels as (revision: number) => void),
    setPinnedSecondaryClosedListener: vi.fn(),
    unpinSecondary: vi.fn()
  }
})
vi.mock('@/store/session-key-states', async () => {
  const { atom } = await import('@/store/atom')

  // MJXHRM-591: the wipe drops only the LEAVING connection's unheld slices, and
  // hands its tabs to that connection's own client — so the switch needs both.
  return {
    $sessionKeyTabs: atom([
      // One tab on the connection being left, one somewhere else.
      { connectionId: 'conn-old', profile: 'work', storedSessionId: 'abc12345', tileKey: 'k1' },
      { connectionId: 'conn-other', profile: 'default', storedSessionId: 'def67890', tileKey: 'k2' }
    ]),
    dropUnheldSessionStates: vi.fn(),
    heldSessionKeys: () => new Set<string>()
  }
})
// Both of these key their caches by the GATEWAY's absolute repo paths. What the
// clearing actually does is asserted in their own suites; here the question is
// whether the wipe calls them at all.
vi.mock('@/store/coding-status', () => ({ resetRepoStatusForBackendSwitch: vi.fn() }))
vi.mock('@/store/pull-requests', () => ({ resetPullRequestsForBackendSwitch: vi.fn() }))
vi.mock('@/lib/query-client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
// NOT mocked: `@/store/artifacts` runs for real below, because "the wipe drops the
// artifact registry" is only worth asserting against the real registry. It reaches
// the native staging commands through `invoke`, which needs a stub outside Tauri.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@/store/session-lifecycle', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $activeStoredSessionId: atom<null | string>(null),
    $messagingSessions: atom<unknown[]>([]),
    // MJXHRM-462 made `store/sidebar-archive`'s `$archivedSessions` a derived
    // atom over this one, and sidebar-archive is evaluated at module scope from
    // this graph — so omitting it fails the whole FILE to import, not one case.
    $removedSessionIds: atom<ReadonlySet<string>>(new Set()),
    $sessions: atom<unknown[]>([]),
    $sessionSearch: atom<unknown[]>([]),
    $sessionsLoading: atom(false),
    $sessionsTotal: atom(0),
    $unreadFinishedSessionIds: atom<string[]>([]),
    // The pinned-row cache is gateway-bound like the list itself. What the
    // clearing does to the atom and its persisted copy is asserted in
    // store/session.test.ts; here the question is whether the wipe calls it.
    clearPinnedSessionCache: vi.fn(),
    forgetLastSessionMarkers: vi.fn(),
    refreshMessagingSessions: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    resetSessionsPaging: vi.fn(),
    // The real predicate — the missing-session check is only meaningful if lineage
    // matching behaves as it does in production.
    sessionMatchesStoredId: (session: { _lineage_root_id?: string; id: string }, storedSessionId: string): boolean =>
      session.id === storedSessionId || session._lineage_root_id === storedSessionId
  }
})

import { readTranscriptTail, saveTranscriptTail } from '@/lib/transcript-tail-cache'
import { $activeConnection } from '@/store/active-connection'
import { resetChat } from '@/store/chat'
import { resetRepoStatusForBackendSwitch } from '@/store/coding-status'
import { $connection, beginGatewaySwitch, disconnect, endGatewaySwitch } from '@/store/connection'
import { $connectionClients, connectionHoldCount } from '@/store/connection-clients'
import { closeGateway } from '@/store/gateway-client'
import type { Connection } from '@/store/gateway-config'
import { dialSavedTarget, type GatewayTarget, loadGatewayTarget } from '@/store/gateway-restore'
import { closeAllSecondaries, releaseParkedTunnels } from '@/store/gateway-secondaries'
import { killLocalBackend, stopLocalBackend } from '@/store/local-backend'
import { notify, notifyError } from '@/store/notifications'
import { $projectTree } from '@/store/project-scope'
import { resetPullRequestsForBackendSwitch } from '@/store/pull-requests'
import { $messagingSessions, $sessions, $sessionsLoading, $unreadFinishedSessionIds } from '@/store/session'
import { dropUnheldSessionStates } from '@/store/session-key-states'
import {
  $activeStoredSessionId,
  $sessionsTotal,
  clearPinnedSessionCache,
  forgetLastSessionMarkers,
  refreshMessagingSessions,
  refreshSessions
} from '@/store/session-lifecycle'
import { disconnectSsh } from '@/store/ssh-backend'
import type { SessionInfo } from '@/types/hermes'

import { artifactsForSession, openArtifact, upsertArtifact } from './artifacts'
import { sessionMissingFromCurrentGateway, softSwitchGateway } from './gateway-soft-switch'
import { $gatewayMode, $gatewaySwitching } from './gateway-switch'
import { $activePreviewPath, $previewTabs, setPreviewTarget } from './preview'
import { $dirtyPreviewPaths, setPreviewDirty } from './preview-edit'

// Only the fields the wipe / switch actually read.
const session = { id: 's1' } as unknown as SessionInfo

const connectionOn = (mode: 'cloud' | 'local' | 'remote' | 'ssh'): Connection =>
  ({ authMode: 'none', baseUrl: 'http://gateway.test', mode }) as Connection

beforeEach(() => {
  localStorage.clear()
  $gatewayMode.set('remote')
  $gatewaySwitching.set(false)
  $connection.set(null)
  // The connection the app is LEAVING — what the wipe has to be told, so it can
  // touch only that one (MJXHRM-591, invariant 37).
  $activeConnection.set({ connectionId: 'conn-old', profile: 'default', scopeKey: 'conn-old' } as never)
  $sessions.set([session])
  $sessionsTotal.set(7)
  $messagingSessions.set([session])
  $unreadFinishedSessionIds.set(['s1'])
  $activeStoredSessionId.set('s1')
  $sessionsLoading.set(false)
  // clearAllMocks only clears calls, not implementations — re-arm the rollback seam
  // so one test's override can't leak into the next.
  vi.mocked(loadGatewayTarget).mockReturnValue(null)
  vi.mocked(dialSavedTarget).mockResolvedValue(undefined)
  vi.mocked(refreshSessions).mockResolvedValue(undefined)
})
afterEach(() => vi.clearAllMocks())

describe('gateway soft switch', () => {
  it('commits the target mode and never hard-disconnects', async () => {
    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect($gatewayMode.get()).toBe('cloud')
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('wipes gateway-bound session state before dialling', async () => {
    let wipedDuringDial = false
    let handedOverDuringDial: { held: boolean; phase: boolean } | null = null

    await softSwitchGateway('remote', async () => {
      wipedDuringDial =
        $sessions.get().length === 0 &&
        $sessionsTotal.get() === 0 &&
        $messagingSessions.get().length === 0 &&
        $unreadFinishedSessionIds.get().length === 0 &&
        $activeStoredSessionId.get() === null &&
        $sessionsLoading.get()
      handedOverDuringDial = {
        held: connectionHoldCount('conn-old') > 0,
        phase: Boolean($connectionClients.get()['conn-old'])
      }
    })

    expect(wipedDuringDial).toBe(true)
    // The LEAVING connection's unheld slices, not every slice in the app: a tab
    // bound to another connection keeps its transcript across a switch it had no
    // part in (MJXHRM-591, invariant 37).
    expect(dropUnheldSessionStates).toHaveBeenCalledOnce()
    // …and it is told WHICH connection is being left: passing nothing would drop
    // every connection's loose slices, including ones this switch never touched.
    expect(vi.mocked(dropUnheldSessionStates).mock.calls[0][0]).toBe('conn-old')
    // …and the tabs bound to it were handed to its OWN client DURING the gap:
    // the hold and the phase exist while the ambient socket is gone and the new
    // one is not yet up, which is only true if the hand-over named A explicitly
    // rather than asking who is active (invariant 46).
    expect(handedOverDuringDial).toEqual({ held: true, phase: true })
    // Skeletons stop once the refresh has landed.
    expect($sessionsLoading.get()).toBe(false)
  })

  // Emptying `$sessions` is not enough on its own: the Pinned section falls back
  // to the cached ROW for every pin precisely so it survives an empty list, so
  // without this it goes on rendering the previous gateway's conversations under
  // the new one — rows the new backend has never heard of and cannot open.
  it('drops the cached pinned rows, which belong to the old gateway', async () => {
    let clearedDuringDial = false

    await softSwitchGateway('remote', async () => {
      clearedDuringDial = vi.mocked(clearPinnedSessionCache).mock.calls.length > 0
    })

    expect(clearedDuringDial).toBe(true)
  })

  // ANOTHER BACKEND CAN RECYCLE STORED IDS — which is why the tail cache is now
  // keyed by `storedKeyFor(connection, profile, id)` rather than by the id
  // alone (MJXHRM-591). With the two spellings unable to collide, the wipe that
  // answered that hazard would only cost every bound tab its cache, so the tails
  // STAY and the remembered-chat marker still goes: `$activeStoredSessionId.set(
  // null)` does not clear the marker (its subscriber ignores null), so it has to
  // be wiped explicitly or the next boot opens backend A's id on backend B.
  it('keeps the cached transcript tails, and still forgets the remembered chat', async () => {
    saveTranscriptTail('@conn-old|default|s1', [
      { id: 'm1', parts: [{ text: 'over there', type: 'text' }], role: 'user' }
    ])

    let forgotDuringDial: boolean | null = null

    await softSwitchGateway('remote', async () => {
      forgotDuringDial = vi.mocked(forgetLastSessionMarkers).mock.calls.length > 0
    })

    expect(forgotDuringDial).toBe(true)
    // The tail of a conversation on the connection we left is still there — it
    // is what makes reopening its tab instant instead of a loader.
    expect(readTranscriptTail('@conn-old|default|s1')).not.toBeNull()
  })

  // A repo path is not gateway-scoped: `/home/me/work` exists on the laptop AND
  // on the box being switched to, and they are different repos on different
  // branches. Carried across, the coding rails paint the previous gateway's
  // branch and ± under the new one's paths, and the is-this-a-repo memo (no TTL)
  // keeps answering for a repo that only ever existed over there.
  it('drops the git + PR caches keyed by the old gateway’s paths, before dialling', async () => {
    let clearedDuringDial = false

    await softSwitchGateway('remote', async () => {
      clearedDuringDial =
        vi.mocked(resetRepoStatusForBackendSwitch).mock.calls.length === 1 &&
        vi.mocked(resetPullRequestsForBackendSwitch).mock.calls.length === 1
    })

    expect(clearedDuringDial).toBe(true)
  })

  // Same story one level up: `projects.tree` is a gateway RPC, so every path in
  // it belongs to the old backend's filesystem — and the FIRST CHAT on the new
  // gateway resolves its directory out of that tree (store/project-scope). The
  // ordering is the assertion: cleared after `resetChat` would seed the fresh
  // draft inside the old gateway's checkout, and no later refresh could take it
  // back.
  it('drops the old gateway’s project tree before the fresh chat is minted', async () => {
    let treeWhenChatReset: unknown[] | null = null

    $projectTree.set([{ id: 'p_1', label: 'one', path: '/repos/one', repos: [], sessionCount: 0 }])
    // `Once`: this file's `clearAllMocks` clears calls, not implementations, so a
    // sticky one would follow the switch into every later test.
    vi.mocked(resetChat).mockImplementationOnce(() => {
      treeWhenChatReset = $projectTree.get()
    })

    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect(treeWhenChatReset).toEqual([])
    expect($projectTree.get()).toEqual([])
  })

  // Artifacts are keyed by sessions on the gateway that produced them. Carried
  // across a switch, an open artifact tab names an id the new backend has never
  // heard of — and the registry keeps the old backend's generated pages alive
  // for the rest of the process.
  // MJXHRM-591: the registry is keyed by the SCOPED session key, so the switch
  // drops the leaving connection's artifacts and leaves every other
  // connection's alone — a bound tab goes on showing the artifact it was
  // showing, which the old wholesale clear made impossible.
  it('drops the leaving connection\u2019s artifacts and its tabs, and no others', async () => {
    const leaving = upsertArtifact(
      '@conn-old|default|s1',
      { kind: 'html', language: 'html', title: 'Dashboard' },
      '<html>v1</html>'
    )!

    const elsewhere = upsertArtifact(
      '@conn-other|default|s2',
      { kind: 'html', language: 'html', title: 'Elsewhere' },
      '<html>other</html>'
    )!

    openArtifact(leaving.artifactId)

    expect($previewTabs.get()).toHaveLength(1)

    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect(artifactsForSession('@conn-old|default|s1')).toEqual([])
    expect(artifactsForSession('@conn-other|default|s2').map(a => a.id)).toEqual([elsewhere.artifactId])
    expect($previewTabs.get()).toEqual([])
    expect($activePreviewPath.get()).toBeNull()
  })

  // The FILE half of the same problem, and the one the artifact wipe above does
  // NOT cover: a preview tab is an absolute path read and written over
  // `/api/fs/*` on whichever gateway is current, so a tab that survives the
  // switch shows the old backend's bytes over the new backend's path — and its
  // save either recreates a file that only existed over there or overwrites a
  // same-named one here.
  it('closes file preview tabs, which name paths on the old gateway', async () => {
    setPreviewTarget('/srv/project/config.ts')
    setPreviewDirty('/srv/project/config.ts', true)

    expect($previewTabs.get()).toHaveLength(1)

    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect($previewTabs.get()).toEqual([])
    expect($activePreviewPath.get()).toBeNull()
    expect($dirtyPreviewPaths.get().has('/srv/project/config.ts')).toBe(false)
  })

  it('holds $gatewaySwitching for the length of the dial', async () => {
    let switchingDuringDial = false

    await softSwitchGateway('remote', async () => {
      switchingDuringDial = $gatewaySwitching.get()
    })

    expect(switchingDuringDial).toBe(true)
    expect($gatewaySwitching.get()).toBe(false)
  })

  it('suspends the reconnect supervisor across the switch', async () => {
    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect(beginGatewaySwitch).toHaveBeenCalledOnce()
    expect(endGatewaySwitch).toHaveBeenCalledOnce()
    expect(vi.mocked(beginGatewaySwitch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(endGatewaySwitch).mock.invocationCallOrder[0]
    )
  })

  it('closes the socket before dialling', async () => {
    const dial = vi.fn().mockResolvedValue(undefined)
    await softSwitchGateway('remote', dial)

    expect(vi.mocked(closeGateway).mock.invocationCallOrder[0]).toBeLessThan(dial.mock.invocationCallOrder[0])
  })

  it('stops a local-spawned backend before closing the socket', async () => {
    $connection.set(connectionOn('local'))
    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect(stopLocalBackend).toHaveBeenCalledOnce()
    expect(vi.mocked(stopLocalBackend).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(closeGateway).mock.invocationCallOrder[0]
    )
  })

  it('releases the ssh tunnel it is leaving, and never hard-kills a local child', async () => {
    $connection.set({ ...connectionOn('ssh'), profile: 'work' })
    $activeConnection.set({ dialConnectionId: 'box' } as never)
    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect(disconnectSsh).toHaveBeenCalledWith('work', 'box')
    expect(vi.mocked(disconnectSsh).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(closeGateway).mock.invocationCallOrder[0]
    )

    $activeConnection.set(null)
    $connection.set(connectionOn('local'))
    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    // A release, not the kill: a background tunnel may still be riding it.
    expect(stopLocalBackend).toHaveBeenCalledOnce()
    expect(killLocalBackend).not.toHaveBeenCalled()
  })

  it("keeps the secondaries' tunnel holds until the new dial has adopted them", async () => {
    let finishDial = () => {}
    const dial = vi.fn(() => new Promise<void>(resolve => (finishDial = resolve)))

    const switching = softSwitchGateway('ssh', dial)

    // Run the switch up to the dial it waits on, and hold it there.
    await vi.waitFor(() => expect(dial).toHaveBeenCalled())

    expect(closeAllSecondaries).toHaveBeenCalledOnce()
    expect(releaseParkedTunnels).not.toHaveBeenCalled()

    finishDial()
    await switching

    // The revision THIS switch began — the one `closeAllSecondaries` answered
    // with — not whatever is newest by the time the dial lands.
    expect(releaseParkedTunnels).toHaveBeenCalledExactlyOnceWith(
      vi.mocked(closeAllSecondaries).mock.results[0]?.value as number
    )
  })

  it('leaves a remote backend alone', async () => {
    $connection.set(connectionOn('remote'))
    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(stopLocalBackend).not.toHaveBeenCalled()
    expect(disconnectSsh).not.toHaveBeenCalled()
  })

  it('refreshes the session lists off the new gateway', async () => {
    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect(refreshSessions).toHaveBeenCalledOnce()
    expect(refreshMessagingSessions).toHaveBeenCalledOnce()
  })

  it('re-throws a failed dial and still stands the guards down', async () => {
    await expect(softSwitchGateway('remote', () => Promise.reject(new Error('nope')))).rejects.toThrow('nope')

    expect($gatewaySwitching.get()).toBe(false)
    expect($sessionsLoading.get()).toBe(false)
    expect(endGatewaySwitch).toHaveBeenCalledOnce()
    expect(refreshSessions).not.toHaveBeenCalled()
  })
})

// The wipe and closeGateway() both run BEFORE the dial, so a failure with no recovery
// leaves an emptied list and a dead socket. These pin the recovery down.
describe('gateway soft switch — failed dial', () => {
  const previousTarget = { mode: 'remote', url: 'old.gateway.test' } as GatewayTarget
  const failing = () => Promise.reject(new Error('unreachable'))

  // Connected to something, with a target to go back to.
  function withPrevious(): void {
    $connection.set(connectionOn('remote'))
    vi.mocked(loadGatewayTarget).mockReturnValue(previousTarget)
  }

  it('rolls back onto the gateway it came from, and still re-throws', async () => {
    withPrevious()

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(dialSavedTarget).toHaveBeenCalledWith(previousTarget)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('reports the switch failure with the reason the dial gave', async () => {
    withPrevious()

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(notifyError).toHaveBeenCalledOnce()
    const [cause, title] = vi.mocked(notifyError).mock.calls[0]
    expect((cause as Error).message).toBe('unreachable')
    expect(title).toBe('Failed to switch gateway')
  })

  it('refills the lists it wiped for a switch that never happened', async () => {
    withPrevious()

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(refreshSessions).toHaveBeenCalledOnce()
    expect(refreshMessagingSessions).toHaveBeenCalledOnce()
  })

  // Nothing left to stand on — the root gate reads $hasConnected, which disconnect()
  // clears, so this is the "drop to the connect screen" path.
  it('goes home when the rollback dial fails too', async () => {
    withPrevious()
    vi.mocked(dialSavedTarget).mockRejectedValueOnce(new Error('old one is gone too'))

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(disconnect).toHaveBeenCalledOnce()
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('goes home when there was no previous connection at all', async () => {
    // $connection is null from beforeEach — a first-ever connect.
    vi.mocked(loadGatewayTarget).mockReturnValue(previousTarget)

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(dialSavedTarget).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('goes home when there is no saved target to roll back to', async () => {
    $connection.set(connectionOn('remote'))
    vi.mocked(loadGatewayTarget).mockReturnValue(null)

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(dialSavedTarget).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('does not roll back a switch that succeeded', async () => {
    withPrevious()

    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(dialSavedTarget).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })
})

// Sessions are per-backend, so the chat the user was on usually does NOT come across
// a switch. The wipe already drops them onto a fresh session; these cover the part
// that explains why, so it doesn't read as the app losing their conversation.
describe('gateway soft switch — session that did not come across', () => {
  const listed = (id: string) => ({ id }) as unknown as SessionInfo

  it('warns when the session the user was on is absent from the new gateway', async () => {
    $activeStoredSessionId.set('s-old')
    vi.mocked(refreshSessions).mockImplementation(async () => {
      $sessions.set([listed('s-other')])
    })

    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(notify).toHaveBeenCalledOnce()
    expect(vi.mocked(notify).mock.calls[0][0]).toMatchObject({
      kind: 'warning',
      title: 'Gateway changed',
      message: "This session doesn't exist on the new gateway."
    })
  })

  it('stays quiet when the session does exist on the new gateway', async () => {
    $activeStoredSessionId.set('s-old')
    vi.mocked(refreshSessions).mockImplementation(async () => {
      $sessions.set([listed('s-old')])
    })

    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(notify).not.toHaveBeenCalled()
  })

  it('stays quiet when no session was open to begin with', async () => {
    $activeStoredSessionId.set(null)
    vi.mocked(refreshSessions).mockImplementation(async () => {
      $sessions.set([listed('s-other')])
    })

    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(notify).not.toHaveBeenCalled()
  })

  // The rollback path puts the user back where they were, so nothing went missing.
  it('does not warn when the switch failed and rolled back', async () => {
    $activeStoredSessionId.set('s-old')
    $connection.set(connectionOn('remote'))
    vi.mocked(loadGatewayTarget).mockReturnValue({ mode: 'remote', url: 'old' } as GatewayTarget)

    await expect(softSwitchGateway('cloud', () => Promise.reject(new Error('nope')))).rejects.toThrow('nope')

    expect(notify).not.toHaveBeenCalled()
  })

  it('matches a session by its lineage root, not just its live id', () => {
    $sessions.set([{ id: 's-new', _lineage_root_id: 's-old' } as unknown as SessionInfo])

    expect(sessionMissingFromCurrentGateway('s-old')).toBe(false)
    expect(sessionMissingFromCurrentGateway('s-gone')).toBe(true)
  })
})

// A dropped list request leaves $sessions empty, which looks exactly like "the new
// gateway has none" — claiming the user's chat is gone on that basis would be a lie.
describe('gateway soft switch — session check needs a real list', () => {
  it('stays quiet when the session list failed to load', async () => {
    $activeStoredSessionId.set('s-old')
    vi.mocked(refreshSessions).mockRejectedValue(new Error('list request dropped'))

    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(notify).not.toHaveBeenCalled()
  })
})
