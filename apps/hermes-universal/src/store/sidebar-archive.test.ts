/**
 * Regression: deleting an archived session left a ghost row that spun forever.
 *
 * Archived rows are excluded from `$sessions` by design and render out of this
 * module's own store, so the tombstone filter every other session surface
 * applies never reached them. The row stayed in the Archived filter, and a
 * click on it resumed a hard-deleted id — resume 404s, the row is still listed,
 * so the "gone session" verdict is `retry` and the spinner never stops.
 * Ported from desktop 3e05033275.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { $removedSessionIds, tombstoneSessions, untombstoneSessions } from '@/store/session'
import { $archivedSessions, $archivedSessionsFetched } from '@/store/sidebar-archive'
import type { SessionInfo } from '@/types/hermes'

const row = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, message_count: 1, source: 'cli', started_at: 0, title: id, ...extra }) as SessionInfo

beforeEach(() => {
  $archivedSessionsFetched.set([])
  $removedSessionIds.set(new Set())
})

describe('$archivedSessions', () => {
  it('drops a row a delete has tombstoned', () => {
    // Seeded PRESENT, which disagrees with the expected outcome: only the
    // tombstone filter can take it back out.
    $archivedSessionsFetched.set([row('a'), row('b')])
    tombstoneSessions(['a'])

    expect($archivedSessions.get().map(s => s.id)).toEqual(['b'])
  })

  it('drops a row tombstoned under its durable lineage root', () => {
    // The delete may arrive holding the root while the archived page lists the
    // live tip after a compression.
    $archivedSessionsFetched.set([row('tip', { _lineage_root_id: 'root' })])
    tombstoneSessions(['root'])

    expect($archivedSessions.get()).toEqual([])
  })

  it('brings the row back when the delete fails and the tombstone lifts', () => {
    $archivedSessionsFetched.set([row('a')])
    tombstoneSessions(['a'])
    untombstoneSessions(['a'])

    expect($archivedSessions.get().map(s => s.id)).toEqual(['a'])
  })

  it('leaves the page alone when nothing is tombstoned', () => {
    const page = [row('a'), row('b')]
    $archivedSessionsFetched.set(page)

    expect($archivedSessions.get()).toEqual(page)
  })
})
