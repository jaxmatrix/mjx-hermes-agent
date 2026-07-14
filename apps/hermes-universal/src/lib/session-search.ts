import { normalize } from '@/lib/text'
import type { SessionInfo } from '@/types/hermes'

// Source terms a session can be matched by in search (platform names etc.).
export function sessionSourceSearchTerms(session: SessionInfo): string[] {
  return session.source ? [session.source] : []
}

// Client-side instant match over a loaded session (id / lineage / title /
// preview / cwd / source). Ported from desktop `lib/session-search.ts`, adapted
// to the universal SessionInfo fields.
export function sessionMatchesSearch(session: SessionInfo, query: string): boolean {
  const needle = normalize(query)

  if (!needle) {
    return true
  }

  return [
    session.id,
    session._lineage_root_id ?? '',
    session.title ?? '',
    session.preview ?? '',
    session.cwd ?? '',
    ...sessionSourceSearchTerms(session)
  ].some(value => value.toLowerCase().includes(needle))
}
