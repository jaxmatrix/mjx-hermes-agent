import { deleteSession, getSessionMessages, listSessions, renameSession, searchSessions, setSessionArchived } from '@/hermes'
import { toChatMessages } from '@/lib/session-history'
import { atom } from '@/store/atom'
import { $busy, $messages, $sessionId, $statusLine, resetChat } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import type { SessionInfo, SessionResumeResponse, SessionSearchResult } from '@/types/hermes'

// Session history + switching (Hc2). Lean adaptation of desktop store/session.ts —
// no windows/projects/pins/profiles/branch/cwd/model. Two ids: the STORED id
// (list rows, $activeStoredSessionId) vs the RUNTIME id ($sessionId in chat.ts,
// what prompt.submit targets), bound by session.resume.

const PAGE = 30

export const $sessions = atom<SessionInfo[]>([])
export const $sessionsLoading = atom(false)
export const $sessionsTotal = atom(0)
export const $sessionsLimit = atom(PAGE)
export const $activeStoredSessionId = atom<null | string>(null)
export const $sessionSearch = atom<SessionSearchResult[]>([])
export const $searchLoading = atom(false)

export async function refreshSessions(): Promise<void> {
  $sessionsLoading.set(true)
  try {
    const res = await listSessions($sessionsLimit.get(), 1, 'exclude', 'recent')
    $sessions.set(res.sessions)
    $sessionsTotal.set(res.total)
  } catch (err) {
    $statusLine.set(err instanceof Error ? err.message : 'Failed to load sessions')
  } finally {
    $sessionsLoading.set(false)
  }
}

// The ported listSessions slices at `limit` with offset=0, so "load more" =
// re-fetch with a bigger limit. FIXME(H): true offset pagination.
export async function loadMoreSessions(): Promise<void> {
  $sessionsLimit.set($sessionsLimit.get() + PAGE)
  await refreshSessions()
}

/** Resume a stored session: hydrate its transcript + bind the runtime id. */
export async function openSession(storedId: string): Promise<void> {
  $activeStoredSessionId.set(storedId)
  $messages.set([])
  $busy.set(true)
  $statusLine.set('')
  try {
    const resumed = await requestGateway<SessionResumeResponse>('session.resume', {
      session_id: storedId,
      cols: 96
    })
    $messages.set(toChatMessages(resumed.messages ?? []))
    $sessionId.set(resumed.session_id ?? storedId)
  } catch {
    // Fallback: static transcript (no live runtime binding).
    try {
      const res = await getSessionMessages(storedId)
      $messages.set(toChatMessages(res.messages ?? []))
      $sessionId.set(storedId)
    } catch (err) {
      $statusLine.set(err instanceof Error ? err.message : 'Failed to open session')
    }
  } finally {
    $busy.set(false)
  }
}

export function newSession(): void {
  resetChat()
  $activeStoredSessionId.set(null)
}

export async function renameSessionLocal(id: string, title: string): Promise<void> {
  const prev = $sessions.get()
  $sessions.set(prev.map(s => (s.id === id ? { ...s, title } : s)))
  try {
    await renameSession(id, title)
  } catch (err) {
    $sessions.set(prev)
    notifyError(err, 'Rename failed')
  }
}

export async function deleteSessionLocal(id: string): Promise<void> {
  const prev = $sessions.get()
  $sessions.set(prev.filter(s => s.id !== id))
  $sessionsTotal.set(Math.max(0, $sessionsTotal.get() - 1))
  if ($activeStoredSessionId.get() === id) newSession()
  try {
    await deleteSession(id)
  } catch (err) {
    $sessions.set(prev)
    $sessionsTotal.set($sessionsTotal.get() + 1)
    notifyError(err, 'Delete failed')
  }
}

export async function archiveSessionLocal(id: string): Promise<void> {
  const prev = $sessions.get()
  $sessions.set(prev.filter(s => s.id !== id))
  if ($activeStoredSessionId.get() === id) newSession()
  try {
    await setSessionArchived(id, true)
  } catch (err) {
    $sessions.set(prev)
    notifyError(err, 'Archive failed')
  }
}

export async function searchSessionsQuery(query: string): Promise<void> {
  const q = query.trim()
  if (!q) {
    $sessionSearch.set([])
    return
  }
  $searchLoading.set(true)
  try {
    const res = await searchSessions(q)
    $sessionSearch.set(res.results ?? [])
  } catch {
    $sessionSearch.set([])
  } finally {
    $searchLoading.set(false)
  }
}
