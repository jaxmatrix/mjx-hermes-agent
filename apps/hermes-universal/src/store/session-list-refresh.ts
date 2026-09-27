/**
 * Canonical sidebar session-list refresh — one writer for `$sessions`.
 *
 * Phone ScrollBody, live-session-status, host.refreshSessions, and the desktop
 * list-actions hook all race-painted the same atom via two code paths
 * (lifecycle full-replace vs listSidebarSessions merge). This module is the
 * single path: batched sidebar endpoint, merge/keep, stale-request guards.
 */

import { refreshCronJobs as refreshCronJobsStore } from '@/app/cron/cron-actions'
import { listAllProfileSessions, listProfileSessionsPage, listSidebarSessions, type SessionInfo } from '@/hermes'
import { sameCronSignature } from '@/lib/session-signatures'
import { isMessagingSource, LOCAL_SESSION_SOURCE_IDS, MESSAGING_SESSION_SOURCE_IDS, normalizeSessionSource } from '@/lib/session-source'
import { logSessionsRoute } from '@/lib/sessions-route-log'
import { gatewayActivationEpoch } from '@/store/gateway'
import { $pinnedSessionIds, $sessionsLimit, SIDEBAR_SESSIONS_PAGE_SIZE } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import { $profileScope, messagingTotalsKey, normalizeProfileKey, sidebarProfileForScope } from '@/store/profile'
import {
  $messagingSessions,
  $selectedStoredSessionId,
  $sessions,
  carryForwardFailedProfileSessions,
  CRON_SECTION_LIMIT,
  keepFailedProfileMeta,
  mergeSessionPage,
  MESSAGING_SECTION_LIMIT,
  setCronSessions,
  setMessagingPlatformTotals,
  setMessagingSessions,
  setMessagingTruncated,
  setSessionProfilesTruncated,
  setSessionProfilesUsage,
  setSessions,
  setSessionsLoading
} from '@/store/session'
import { $removedSessionIds } from '@/store/session-removal'
import { $sessionTiles, $workingSessionIds, getRecentlySettledSessionIds } from '@/store/session-states'

/** Recents exclude: cron/kanban/oneshot/tool + every messaging platform. */
export const SIDEBAR_EXCLUDED_SOURCES = [
  'cron',
  'kanban',
  'oneshot',
  'subagent',
  'tool',
  ...MESSAGING_SESSION_SOURCE_IDS
]

/** Messaging slice: drop cron + local sources. */
export const MESSAGING_EXCLUDED_SOURCES = ['cron', ...LOCAL_SESSION_SOURCE_IDS]

let refreshSessionsRequestId = 0

function dropTombstoned(sessions: SessionInfo[]): SessionInfo[] {
  const tombstones = $removedSessionIds.get()

  return tombstones.size
    ? sessions.filter(s => !tombstones.has(s.id) && !(s._lineage_root_id && tombstones.has(s._lineage_root_id)))
    : sessions
}

/** Rows a refresh must preserve even if the aggregator omits them. */
export function sessionsToKeep(scope?: string): Set<string> {
  const keep = new Set<string>([
    ...$workingSessionIds.get(),
    ...$pinnedSessionIds.get(),
    ...getRecentlySettledSessionIds()
  ])

  for (const tile of $sessionTiles.get()) {
    keep.add(tile.storedSessionId)
  }

  const active = $selectedStoredSessionId.get()

  if (active) {
    const session = scope ? $sessions.get().find(s => s.id === active) : null

    if (!scope || !session || normalizeProfileKey(session.profile) === scope) {
      keep.add(active)
    }
  }

  return keep
}

export interface RefreshSidebarSessionsOptions {
  /** When set, scopes the fetch (same as the React hook's profileScope). */
  profileScope?: string
  /** Abort publish if the caller lost ownership (gateway switch). */
  shouldPublish?: () => boolean
  /** Skip cron.jobs refresh (tests / nested calls). */
  skipCronJobs?: boolean
}

/**
 * Refresh every sidebar session slice. Returns whether this call published.
 * Bumps nothing on stale/aborted responses.
 */
export async function refreshSidebarSessions(
  options: RefreshSidebarSessionsOptions = {}
): Promise<{ published: boolean; serverSessionIds: string[] }> {
  const shouldPublish = options.shouldPublish ?? (() => true)
  const profileScope = options.profileScope ?? $profileScope.get()
  const sessionProfile = sidebarProfileForScope(profileScope)
  const activationEpoch = gatewayActivationEpoch()

  if (!shouldPublish()) {
    return { published: false, serverSessionIds: [] }
  }

  const requestId = ++refreshSessionsRequestId
  const showLoading = $sessions.get().length === 0

  if (showLoading && shouldPublish()) {
    setSessionsLoading(true)
  }

  let published = false
  let serverSessionIds: string[] = []

  try {
    const limit = $sessionsLimit.get()
    const result = await listSidebarSessions({
      recentsProfile: sessionProfile,
      recentsLimit: limit,
      recentsExclude: SIDEBAR_EXCLUDED_SOURCES,
      cronLimit: CRON_SECTION_LIMIT,
      messagingLimit: MESSAGING_SECTION_LIMIT,
      messagingExclude: MESSAGING_EXCLUDED_SOURCES
    })

    if (
      !shouldPublish() ||
      refreshSessionsRequestId !== requestId ||
      gatewayActivationEpoch() !== activationEpoch ||
      sidebarProfileForScope(options.profileScope ?? $profileScope.get()) !== sessionProfile
    ) {
      return { published: false, serverSessionIds: [] }
    }

    const recents = result.recents
    serverSessionIds = (recents.sessions ?? []).map(session => session.id)

    setSessions(prev => {
      const incoming = dropTombstoned(
        carryForwardFailedProfileSessions(prev, recents.sessions ?? [], recents.errors ?? result.errors)
      )
      const next = mergeSessionPage(prev, incoming, sessionsToKeep())

      return sameCronSignature(prev, next) ? prev : next
    })

    const recentsErrors = recents.errors ?? result.errors

    setSessionProfilesTruncated(prev => {
      const next = keepFailedProfileMeta(prev, recents.profiles_truncated ?? {}, recentsErrors)
      const prevKeys = Object.keys(prev)

      return prevKeys.length === Object.keys(next).length && prevKeys.every(key => prev[key] === next[key])
        ? prev
        : next
    })

    setSessionProfilesUsage(prev => {
      const next = keepFailedProfileMeta(prev, recents.profiles_usage ?? {}, recentsErrors)
      const prevKeys = Object.keys(prev)

      return prevKeys.length === Object.keys(next).length &&
        prevKeys.every(
          key => prev[key]?.tokens === next[key]?.tokens && prev[key]?.cost_usd === next[key]?.cost_usd
        )
        ? prev
        : next
    })

    setCronSessions(prev => {
      const incoming = carryForwardFailedProfileSessions(
        prev,
        result.cron.sessions ?? [],
        result.cron.errors ?? result.errors
      )

      return sameCronSignature(prev, incoming) ? prev : incoming
    })

    const messagingErrors = result.messaging.errors ?? result.errors

    setMessagingSessions(prev => {
      const messagingRows = dropTombstoned(
        carryForwardFailedProfileSessions(
          prev,
          (result.messaging.sessions ?? []).filter(s => isMessagingSource(s.source)),
          messagingErrors
        )
      )

      return sameCronSignature(prev, messagingRows) ? prev : messagingRows
    })

    setMessagingTruncated(prev =>
      messagingErrors?.length ? prev : result.messaging.sessions.length >= MESSAGING_SECTION_LIMIT
    )

    published = true
  } catch (err) {
    logSessionsRoute('refreshSessions_failed', {
      err: String(err),
      limit: $sessionsLimit.get(),
      scope: sessionProfile
    })
    notifyError(err, 'Failed to load sessions')
  } finally {
    if (showLoading && shouldPublish() && refreshSessionsRequestId === requestId) {
      setSessionsLoading(false)
    }
  }

  if (published && !options.skipCronJobs && shouldPublish()) {
    void refreshCronJobsStore(sessionProfile).catch(() => undefined)
  }

  return { published, serverSessionIds }
}

/**
 * Append the next recency page without re-fetching the whole loaded window.
 * Bumps `$sessionsLimit` by the page's recency depth (not raw row count —
 * back-filled pins must not advance the cursor).
 */
export async function loadMoreSidebarSessions(
  options: { profileScope?: string; shouldPublish?: () => boolean } = {}
): Promise<void> {
  const shouldPublish = options.shouldPublish ?? (() => true)
  const profileScope = options.profileScope ?? $profileScope.get()
  const sessionProfile = sidebarProfileForScope(profileScope)
  const activationEpoch = gatewayActivationEpoch()

  if (!shouldPublish() || sidebarProfileForScope($profileScope.get()) !== sessionProfile) {
    return
  }

  const offset = $sessionsLimit.get()
  const pageSize = SIDEBAR_SESSIONS_PAGE_SIZE

  try {
    const res = await listProfileSessionsPage(
      pageSize,
      1,
      'exclude',
      'recent',
      sessionProfile,
      { excludeSources: SIDEBAR_EXCLUDED_SOURCES },
      offset
    )

    if (
      !shouldPublish() ||
      gatewayActivationEpoch() !== activationEpoch ||
      sidebarProfileForScope(options.profileScope ?? $profileScope.get()) !== sessionProfile
    ) {
      return
    }

    const incoming = dropTombstoned(
      carryForwardFailedProfileSessions($sessions.get(), res.sessions ?? [], res.errors)
    )

    setSessions(prev => {
      const keep = new Set(sessionsToKeep())

      for (const session of prev) {
        keep.add(session.id)

        if (session._lineage_root_id) {
          keep.add(session._lineage_root_id)
        }
      }

      const next = mergeSessionPage(prev, incoming, keep)

      return sameCronSignature(prev, next) ? prev : next
    })

    const depth = Math.min(res.sessions?.length ?? 0, pageSize)
    $sessionsLimit.set(offset + depth)

    // A full page means the aggregator likely has more — mark truncated.
    const truncKey = sessionProfile
    setSessionProfilesTruncated(prev => ({
      ...prev,
      [truncKey]: depth >= pageSize
    }))
  } catch (err) {
    logSessionsRoute('loadMoreSessions_failed', {
      err: String(err),
      offset,
      scope: sessionProfile
    })
    notifyError(err, 'Failed to load more sessions')
  }
}

const loadMoreMessagingRequestIds: Record<string, number> = {}

/** Page one messaging platform without replacing another platform's rows. */
export async function loadMoreMessagingForPlatform(
  platform: string,
  options: { profileScope?: string; shouldPublish?: () => boolean } = {}
): Promise<void> {
  const shouldPublish = options.shouldPublish ?? (() => true)
  const profileScope = options.profileScope ?? $profileScope.get()
  const sessionProfile = sidebarProfileForScope(profileScope)
  const activationEpoch = gatewayActivationEpoch()

  if (!shouldPublish()) {
    return
  }

  const requestKey = messagingTotalsKey(sessionProfile, platform)
  const requestId = (loadMoreMessagingRequestIds[requestKey] ?? 0) + 1
  loadMoreMessagingRequestIds[requestKey] = requestId

  const inProfile = (s: SessionInfo) =>
    sessionProfile === 'all' || normalizeProfileKey(s.profile) === sessionProfile

  const inPlatform = (s: SessionInfo) => normalizeSessionSource(s.source) === platform && inProfile(s)
  const loaded = $messagingSessions.get().filter(inPlatform).length

  let result

  try {
    result = await listAllProfileSessions(
      loaded + SIDEBAR_SESSIONS_PAGE_SIZE,
      1,
      'exclude',
      'recent',
      sessionProfile,
      { source: platform }
    )
  } catch {
    return
  }

  if (
    loadMoreMessagingRequestIds[requestKey] !== requestId ||
    !shouldPublish() ||
    gatewayActivationEpoch() !== activationEpoch
  ) {
    return
  }

  const incoming = dropTombstoned(result.sessions.filter(inPlatform))

  setMessagingSessions(prev => [
    ...prev.filter(s => !inPlatform(s)),
    ...mergeSessionPage(
      prev.filter(inPlatform),
      carryForwardFailedProfileSessions(prev.filter(inPlatform), incoming, result.errors),
      sessionsToKeep()
    )
  ])

  const total = result.total ?? incoming.length

  setMessagingPlatformTotals(prev => ({ ...prev, [requestKey]: Math.max(total, incoming.length) }))
}

/** Test helper: reset the module request counter between cases. */
export function __resetSidebarRefreshRequestIdForTests(): void {
  refreshSessionsRequestId = 0
  for (const key of Object.keys(loadMoreMessagingRequestIds)) {
    delete loadMoreMessagingRequestIds[key]
  }
}
