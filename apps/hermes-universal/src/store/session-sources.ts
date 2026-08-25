import { api } from '@/lib/api'
import type { PaginatedSessions, SessionInfo } from '@/types/hermes'

import { $connectionsRegistry, type ConnectionView } from './connections'

/**
 * THE CROSS-GATEWAY SESSION LIST.
 *
 * The active source's rows keep coming from `store/session.ts` exactly as today;
 * this is an ADDITION on top, and with one connection it is never called at all
 * — so the wire for a single-source install is byte-identical (acceptance
 * criterion 1).
 *
 * Three rules, each of which is a data-loss bug if broken:
 *
 *  1. **`include_hidden` is NEVER sent.** The backend's default `hidden = 0`
 *     filter is what keeps Bot Mode's canonical chats (MJXHRM-445) out of this
 *     list exactly as it keeps local ones out. Desktop states it as a comment
 *     on `profile-session-routing.ts`; here it is a hard rule with a test that
 *     greps the built paths.
 *  2. **Session ids are never rewritten** (rule 17). A merged row carries its
 *     own id and a `connection_id` TAG beside it.
 *  3. **Dedupe on the PAIR `(connection_id, id)`.** Two gateways can mint the
 *     same session id; desktop dedupes on the id alone, which is safe only
 *     because its splice merges one v1 override into one list. The pair costs a
 *     string concat and removes the whole "my chat opened someone else's
 *     transcript" class.
 */

/** How deep one page may go. A larger request is split, so a paged read orders
 *  identically to one large read. */
export const REMOTE_SESSION_PAGE_LIMIT = 100

/** Per source, so one slow gateway cannot hold the sidebar. */
const PER_SOURCE_TIMEOUT_MS = 10_000

export interface SourceSessionRow extends SessionInfo {
  /** CLIENT-MINTED. The gateway neither sends nor accepts this field. */
  connection_id: string
}

export interface SourceSessionParams {
  limit?: number
  offset?: number
  minMessages?: number
  archived?: 'exclude' | 'include' | 'only'
  order?: 'created' | 'recent'
}

function query(params: SourceSessionParams, withProfile: boolean): string {
  const limit = Math.min(Math.max(1, params.limit ?? 40), REMOTE_SESSION_PAGE_LIMIT)

  const parts = [
    `limit=${limit}`,
    `offset=${Math.max(0, params.offset ?? 0)}`,
    `min_messages=${Math.max(0, params.minMessages ?? 0)}`,
    `archived=${params.archived ?? 'exclude'}`,
    `order=${params.order ?? 'recent'}`
  ]

  if (withProfile) {
    parts.push('profile=all')
  }

  return parts.join('&')
}

/** Which rows one source can serve. Errors contribute NOTHING — an unreachable
 *  gateway must never break the sidebar. */
async function readSource(source: ConnectionView, params: SourceSessionParams): Promise<SourceSessionRow[]> {
  const tag = (sessions: SessionInfo[], profile: string): SourceSessionRow[] =>
    sessions.map(session => ({
      ...session,
      connection_id: source.id,
      // A row from another machine is never "the default profile" of THIS one;
      // saying otherwise would let it inherit the active source's scope.
      is_default_profile: false,
      profile: session.profile || profile
    }))

  const fallbackProfile = source.remoteProfile || 'default'

  // An ssh backend serves its own state.db, so it has no cross-profile
  // aggregator to ask — and asking for `profile=all` would 404 or, worse, be
  // silently ignored.
  if (source.kind === 'ssh' || source.kind === 'local') {
    const page = await api<PaginatedSessions>({
      connectionId: source.id,
      path: `/api/sessions?${query(params, false)}`,
      timeoutMs: PER_SOURCE_TIMEOUT_MS
    })

    return tag(page.sessions ?? [], fallbackProfile)
  }

  try {
    const page = await api<PaginatedSessions>({
      connectionId: source.id,
      path: `/api/profiles/sessions?${query(params, true)}`,
      timeoutMs: PER_SOURCE_TIMEOUT_MS
    })

    return tag(page.sessions ?? [], fallbackProfile)
  } catch {
    // A gateway older than the aggregator. Fall back to the single-profile read
    // rather than dropping the source entirely.
    const page = await api<PaginatedSessions>({
      connectionId: source.id,
      path: `/api/sessions?${query(params, false)}`,
      timeoutMs: PER_SOURCE_TIMEOUT_MS
    })

    return tag(page.sessions ?? [], fallbackProfile)
  }
}

/**
 * Read every NON-active source, concurrently.
 *
 * `excludeConnectionId` is the active one: its rows already arrive through
 * `store/session.ts`, and reading it twice would double every row and double the
 * traffic.
 */
export async function fetchRegistrySessionRows(
  params: SourceSessionParams = {},
  excludeConnectionId?: null | string
): Promise<SourceSessionRow[]> {
  const sources = $connectionsRegistry
    .get()
    .connections.filter(source => source.id !== excludeConnectionId && Boolean(source.url))

  if (sources.length === 0) {
    return []
  }

  const pages = await Promise.all(
    // `.catch(() => [])` per source, deliberately: one dead gateway contributes
    // nothing and everything else still lands.
    sources.map(source => readSource(source, params).catch(() => [] as SourceSessionRow[]))
  )

  return pages.flat()
}

/** The identity of a merged row. NOT the id alone — see rule 3 above. */
export function sessionRowKey(connectionId: null | string | undefined, sessionId: string): string {
  return `${connectionId ?? ''}\0${sessionId}`
}

const ownerByStoredId = new Map<string, string>()

/** Which source a stored session id came from, for the request router. */
export function connectionIdForSession(storedSessionId: null | string): null | string {
  return storedSessionId ? (ownerByStoredId.get(storedSessionId) ?? null) : null
}

export function forgetSessionSources(): void {
  ownerByStoredId.clear()
}

/**
 * Merge foreign rows into the active list.
 *
 * Recency order is preserved and the pair is the dedupe key, so a row the active
 * gateway also serves wins (it is the one that can be opened without a switch).
 */
export function spliceRegistrySessionRows(
  active: SessionInfo[],
  foreign: SourceSessionRow[],
  activeConnectionId: null | string
): SourceSessionRow[] {
  const merged = new Map<string, SourceSessionRow>()

  for (const session of active) {
    merged.set(sessionRowKey(activeConnectionId, session.id), {
      ...session,
      connection_id: activeConnectionId ?? ''
    })
  }

  for (const row of foreign) {
    const key = sessionRowKey(row.connection_id, row.id)

    if (!merged.has(key)) {
      merged.set(key, row)
    }
  }

  // The same recency key the session list already sorts on: `ended_at` when a
  // session finished, `started_at` otherwise.
  const recency = (row: SourceSessionRow): number => Number(row.ended_at ?? row.started_at ?? 0)
  const rows = [...merged.values()].sort((a, b) => recency(b) - recency(a))

  ownerByStoredId.clear()

  for (const row of rows) {
    if (row.connection_id) {
      ownerByStoredId.set(row.id, row.connection_id)
    }
  }

  return rows
}

/**
 * One window across several sources.
 *
 * A `limit` beyond `REMOTE_SESSION_PAGE_LIMIT` is split into whole pages so no
 * source is asked for a window it will silently short-serve, and the pages are
 * merged before the truncation, so a paged read orders identically to one large
 * read.
 */
export async function mergeSourceSessionWindow(
  active: SessionInfo[],
  params: SourceSessionParams,
  activeConnectionId: null | string
): Promise<SourceSessionRow[]> {
  const wanted = Math.max(1, params.limit ?? 40)
  const pages: SourceSessionRow[] = []

  for (let offset = 0; offset < wanted; offset += REMOTE_SESSION_PAGE_LIMIT) {
    const limit = Math.min(REMOTE_SESSION_PAGE_LIMIT, wanted - offset)

    pages.push(
      ...(await fetchRegistrySessionRows(
        { ...params, limit, offset: (params.offset ?? 0) + offset },
        activeConnectionId
      ))
    )
  }

  return spliceRegistrySessionRows(active, pages, activeConnectionId).slice(0, wanted)
}
