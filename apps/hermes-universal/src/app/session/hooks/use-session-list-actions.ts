import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import { listAllProfileSessions, type SessionInfo } from '@/hermes'
import { sameCronSignature } from '@/lib/session-signatures'
import { isMessagingSource } from '@/lib/session-source'
import { gatewayActivationEpoch } from '@/store/gateway'
import {
  $sessionsLimit,
  raiseSessionsLimit,
  SIDEBAR_FILTERED_PAGE_SIZE,
  $sidebarFiltersActive
} from '@/store/layout'
import { sidebarProfileForScope } from '@/store/profile'
import {
  MESSAGING_SECTION_LIMIT,
  setMessagingSessions,
  setMessagingTruncated
} from '@/store/session'
import { $removedSessionIds } from '@/store/session-removal'
import {
  MESSAGING_EXCLUDED_SOURCES,
  loadMoreMessagingForPlatform as loadMoreMessagingForPlatformShared,
  loadMoreSidebarSessions,
  refreshSidebarSessions
} from '@/store/session-list-refresh'

import { refreshCronJobs as refreshCronJobsStore } from '../../cron/cron-actions'

function dropTombstoned(sessions: SessionInfo[]): SessionInfo[] {
  const tombstones = $removedSessionIds.get()

  return tombstones.size
    ? sessions.filter(s => !tombstones.has(s.id) && !(s._lineage_root_id && tombstones.has(s._lineage_root_id)))
    : sessions
}

interface UseSessionListActionsArgs {
  profileScope: string
}

/** Owns the sidebar's session-list fetching + paging: recents, cron runs/jobs,
 *  and the per-platform messaging slices. Returns the callbacks the controller
 *  wires into the sidebar and refresh effects. */
export function useSessionListActions({ profileScope }: UseSessionListActionsArgs) {
  const profileScopeRef = useRef(profileScope)
  const refreshMessagingSessionsRequestRef = useRef(0)

  useLayoutEffect(() => {
    profileScopeRef.current = profileScope
  }, [profileScope])

  /** Refresh the active profile's messaging-platform sidebar slice. */
  const refreshMessagingSessions = useCallback(async () => {
    const sessionProfile = sidebarProfileForScope(profileScope)
    const activationEpoch = gatewayActivationEpoch()

    // A callback captured before a profile switch may still be queued by an
    // event subscription. Do not let it start a request against the old scope.
    if (sidebarProfileForScope(profileScopeRef.current) !== sessionProfile) {
      return
    }

    const requestId = refreshMessagingSessionsRequestRef.current + 1
    refreshMessagingSessionsRequestRef.current = requestId

    try {
      const result = await listAllProfileSessions(MESSAGING_SECTION_LIMIT, 1, 'exclude', 'recent', sessionProfile, {
        excludeSources: MESSAGING_EXCLUDED_SOURCES
      })

      if (
        refreshMessagingSessionsRequestRef.current !== requestId ||
        sidebarProfileForScope(profileScopeRef.current) !== sessionProfile ||
        gatewayActivationEpoch() !== activationEpoch
      ) {
        return
      }

      // Drop any non-messaging source the broad exclude didn't catch (custom
      // sources) — those stay in local recents, not a platform section.
      const rows = dropTombstoned(result.sessions.filter(s => isMessagingSource(s.source)))

      setMessagingSessions(prev => (sameCronSignature(prev, rows) ? prev : rows))
      // Hit the cap → at least one platform may have more on disk than loaded,
      // so platform sections offer their own per-platform "load more".
      setMessagingTruncated(result.sessions.length >= MESSAGING_SECTION_LIMIT)
    } catch {
      // Non-fatal: the messaging sections just stay empty/stale.
    }
  }, [profileScope])

  /** Page one messaging platform without replacing another platform's rows. */
  const loadMoreMessagingForPlatform = useCallback(
    async (platform: string) => {
      const sessionProfile = sidebarProfileForScope(profileScope)

      await loadMoreMessagingForPlatformShared(platform, {
        profileScope,
        shouldPublish: () => sidebarProfileForScope(profileScopeRef.current) === sessionProfile
      })
    },
    [profileScope]
  )

  /** Refresh cron jobs only while the profile that requested them remains active. */
  const refreshCronJobs = useCallback(async () => {
    const sessionProfile = sidebarProfileForScope(profileScope)

    if (sidebarProfileForScope(profileScopeRef.current) !== sessionProfile) {
      return
    }

    try {
      await refreshCronJobsStore(sessionProfile)
    } catch {
      // Non-fatal: the cron section just keeps its last-known jobs.
    }
  }, [profileScope])

  /** Refresh every sidebar session slice without committing an obsolete profile response. */
  const refreshSessions = useCallback(
    async (shouldPublish: () => boolean = () => true) => {
      const sessionProfile = sidebarProfileForScope(profileScope)

      if (!shouldPublish() || sidebarProfileForScope(profileScopeRef.current) !== sessionProfile) {
        return
      }

      await refreshSidebarSessions({
        profileScope,
        shouldPublish: () =>
          shouldPublish() && sidebarProfileForScope(profileScopeRef.current) === sessionProfile,
        skipCronJobs: true
      })

      if (shouldPublish() && sidebarProfileForScope(profileScopeRef.current) === sessionProfile) {
        void refreshCronJobs()
      }
    },
    [profileScope, refreshCronJobs]
  )

  const loadMoreSessions = useCallback(async () => {
    const sessionProfile = sidebarProfileForScope(profileScope)

    await loadMoreSidebarSessions({
      profileScope,
      shouldPublish: () => sidebarProfileForScope(profileScopeRef.current) === sessionProfile
    })
  }, [profileScope])

  // A filter searches the loaded page, so switching one on has to deepen the
  // page — otherwise "merged PRs" answers for the last 50 rows and reads as
  // "you only have 6 merged PRs". Clearing the filters hands the window back:
  // the list refreshes on every settled turn, and paying for 300 rows a turn
  // once the view is unfiltered again buys nothing. Whatever the user had
  // paged to by hand is what it returns to.
  const unfilteredLimit = useRef<null | number>(null)

  useEffect(
    () =>
      $sidebarFiltersActive.subscribe(active => {
        if (active) {
          unfilteredLimit.current ??= $sessionsLimit.get()

          if (raiseSessionsLimit(SIDEBAR_FILTERED_PAGE_SIZE)) {
            void refreshSessions()
          }
        } else if (unfilteredLimit.current !== null) {
          const restored = unfilteredLimit.current
          unfilteredLimit.current = null

          if ($sessionsLimit.get() > restored) {
            $sessionsLimit.set(restored)
            void refreshSessions()
          }
        }
      }),
    [refreshSessions]
  )

  return {
    loadMoreMessagingForPlatform,
    loadMoreSessions,
    refreshCronJobs,
    refreshMessagingSessions,
    refreshSessions
  }
}
