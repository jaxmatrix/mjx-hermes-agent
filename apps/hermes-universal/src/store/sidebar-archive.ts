import { listAllProfileSessions } from '@/hermes'
import { atom, computed } from '@/store/atom'
import type { SessionInfo } from '@/types/hermes'

import { $removedSessionIds, $sessions, withoutTombstoned } from './session'

// Ported from desktop `store/sidebar-archive.ts`.
//
// Archived rows are excluded from the sessions query, so the Archived view has
// to fetch its own set. Capped: it's a lookup surface, not a feed.
const ARCHIVED_FETCH_LIMIT = 200

/**
 * The fetched page, exactly as the backend returned it. Writers use this; every
 * READER should use `$archivedSessions` below.
 */
export const $archivedSessionsFetched = atom<SessionInfo[]>([])

/**
 * The Archived view's rows, minus anything a delete has tombstoned.
 *
 * Archived rows are excluded from `$sessions` by design and render out of this
 * store instead, so the tombstone filter every other session surface already
 * applies (`refreshSessions`, `loadMoreSessions`, the project tree) never
 * reached them: deleting from the Archived filter left the row in place, and a
 * click on it resumed a hard-deleted id — resume 404s, the row is still listed,
 * so the verdict is "retry" and the spinner never stops.
 *
 * Derived rather than pruned imperatively in `deleteSessionLocal` (which is
 * what desktop does) for two reasons: `store/session.ts` importing this module
 * would close an import cycle, and deriving covers EVERY removal path at once
 * — the six surfaces that funnel into `deleteSessionLocal`, and any future one
 * — instead of the single call site the bug was reported against. It also gets
 * the restore-on-failure for free: `untombstoneSessions` in the delete's catch
 * lifts the tombstone and the row reappears, with no snapshot to keep.
 */
export const $archivedSessions = computed([$archivedSessionsFetched, $removedSessionIds], fetched =>
  withoutTombstoned(fetched)
)

export const $archivedSessionsLoading = atom(false)

export async function loadArchivedSessions(): Promise<void> {
  if ($archivedSessionsLoading.get()) {
    return
  }

  $archivedSessionsLoading.set(true)

  try {
    const result = await listAllProfileSessions(ARCHIVED_FETCH_LIMIT, 0, 'only')

    $archivedSessionsFetched.set(result.sessions)
  } catch {
    $archivedSessionsFetched.set([])
  } finally {
    $archivedSessionsLoading.set(false)
  }
}

/** Drop the fetched set because the gateway changed — these are another
 *  backend's rows, and the sidebar would otherwise show them until the next
 *  time the user opens the Archived view. */
export function resetArchivedSessionsForBackendSwitch(): void {
  $archivedSessionsFetched.set([])
}

/** Spend on a session — provider-reported price when we have one, our own
 *  estimate otherwise. */
export const sessionCostUsd = (session: SessionInfo): number =>
  session.actual_cost_usd || session.estimated_cost_usd || 0

/** Whether ANY loaded session reports spend. Subscription auth never quotes a
 *  price, so for those users a cost sort would rank a list of zeroes — the
 *  menu hides the option instead of offering a dead one. */
export const $sessionsHaveCost = computed($sessions, sessions => sessions.some(session => sessionCostUsd(session) > 0))
