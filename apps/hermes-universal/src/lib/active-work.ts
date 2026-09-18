/**
 * What a backend is in the middle of, for a confirmation that would stop it.
 *
 * Ported from upstream desktop's quit guard (`apps/desktop/electron/quit-guard.ts`):
 * the same `ActiveWork` shape, the same merge (windows and sources can report the
 * same session) and the same four-title listing.
 */

export const MAX_LISTED = 4

export interface ActiveWork {
  /** Titles of sessions running a turn. Untitled sessions contribute a count only. */
  titles: string[]
  /** Running turns, including untitled ones — always >= titles.length. */
  count: number
}

export const NO_ACTIVE_WORK: ActiveWork = { count: 0, titles: [] }

/** Merge several reports into one. */
export function mergeActiveWork(reports: Iterable<ActiveWork>): ActiveWork {
  const titles: string[] = []
  let count = 0

  for (const report of reports) {
    count = Math.max(count, report.count)

    for (const title of report.titles) {
      if (!titles.includes(title)) {
        titles.push(title)
      }
    }
  }

  return { count: Math.max(count, titles.length), titles }
}

/** The live rows of `session.active_list`: anything not idle is mid-turn. */
export function activeWorkFromLiveSessions(rows: readonly { status?: string; title?: string }[]): ActiveWork {
  const live = rows.filter(row => row.status && row.status !== 'idle')
  const titles = live.map(row => (row.title ?? '').trim()).filter(Boolean)

  return { count: live.length, titles: [...new Set(titles)] }
}
