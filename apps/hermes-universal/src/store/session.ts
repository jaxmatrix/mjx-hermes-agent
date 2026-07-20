import {
  deleteSession,
  getSessionMessages,
  listAllProfileSessions,
  listSessions,
  renameSession,
  searchSessions,
  setSessionArchived
} from '@/hermes'
import { toChatMessages } from '@/lib/session-history'
import { atom, computed } from '@/store/atom'
import { $busy, $clarify, $currentCwd, $messages, $sessionId, $statusLine, resetChat, setCurrentCwd } from '@/store/chat'
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
// Compat alias for ported desktop code (`@/store/session` → `$activeSessionId`).
// Universal's stored id IS the desktop "active session" id for a single-session app.
export const $activeSessionId = $activeStoredSessionId
export const $sessionSearch = atom<SessionSearchResult[]>([])
export const $searchLoading = atom(false)

// Sidebar row state. Universal drives a single active session, so "working" =
// the active row while a turn streams, and "needs input" = the active row while
// a clarify prompt is pending. (Desktop tracks these across many sessions via
// gateway events; the sidebar row API is the same Set/array shape.)
export const $workingSessionIds = computed(
  [$busy, $activeStoredSessionId],
  (busy, activeId) => (busy && activeId ? new Set([activeId]) : new Set<string>())
)
export const $attentionSessionIds = computed([$clarify, $activeStoredSessionId], (clarify, activeId) =>
  clarify && activeId ? [activeId] : []
)

/** Title of the currently-viewed chat (title → first-message preview → ''),
 *  parity with desktop's `sessionTitle`. Empty for a fresh/unsaved chat — the
 *  titlebar / mobile header show their brand fallback then. Drives the topbar. */
export const $activeSessionTitle = computed([$sessions, $activeStoredSessionId], (sessions, activeId) => {
  if (!activeId) return ''
  const session = sessions.find(s => s.id === activeId)
  return session ? (session.title?.trim() || session.preview?.trim() || '') : ''
})

/** Functional setter for optimistic row edits (rename dialog etc.). */
export function setSessions(updater: (prev: SessionInfo[]) => SessionInfo[]): void {
  $sessions.set(updater($sessions.get()))
}

/** Durable pin key: the lineage-root id survives auto-compression's id rotation. */
export function sessionPinId(session: SessionInfo): string {
  return session._lineage_root_id ?? session.id
}

// ── Messaging-platform sessions (Discord, Telegram, …) ──────────────────────
const MESSAGING_SOURCES = new Set([
  'api_server',
  'bluebubbles',
  'discord',
  'email',
  'homeassistant',
  'matrix',
  'mattermost',
  'qqbot',
  'signal',
  'slack',
  'sms',
  'telegram',
  'webhook',
  'weixin',
  'whatsapp',
  'yuanbao'
])

export function isMessagingSource(source: null | string): boolean {
  return !!source && MESSAGING_SOURCES.has(source.toLowerCase())
}

const MESSAGING_SOURCE_LABELS: Record<string, string> = {
  api_server: 'API',
  bluebubbles: 'iMessage',
  discord: 'Discord',
  email: 'Email',
  homeassistant: 'Home Assistant',
  matrix: 'Matrix',
  mattermost: 'Mattermost',
  qqbot: 'QQ',
  signal: 'Signal',
  slack: 'Slack',
  sms: 'SMS',
  telegram: 'Telegram',
  webhook: 'Webhook',
  weixin: 'WeChat',
  whatsapp: 'WhatsApp',
  yuanbao: 'Yuanbao'
}

export function messagingSourceLabel(source: string): string {
  return MESSAGING_SOURCE_LABELS[source.toLowerCase()] ?? source.charAt(0).toUpperCase() + source.slice(1)
}

export const $messagingSessions = atom<SessionInfo[]>([])

// Cross-platform messaging sessions, kept in their own slice so a busy platform
// doesn't crowd out the recents page (they're excluded from the recents fetch).
export async function refreshMessagingSessions(): Promise<void> {
  try {
    const res = await listAllProfileSessions(100, 1, 'exclude', 'recent', 'all', { excludeSources: ['cron'] })
    $messagingSessions.set((res.sessions ?? []).filter(session => isMessagingSource(session.source)))
  } catch {
    // Best-effort; keep the last known slice.
  }
}

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
  // Each stored session carries the project directory it runs in. Restore it up
  // front from the list row so the statusbar / file tree switch with the chat
  // immediately; the resume response's runtime info supersedes it below with the
  // authoritative value.
  setCurrentCwd($sessions.get().find(session => session.id === storedId)?.cwd)
  try {
    const resumed = await requestGateway<SessionResumeResponse>('session.resume', {
      session_id: storedId,
      cols: 96
    })
    $messages.set(toChatMessages(resumed.messages ?? []))
    $sessionId.set(resumed.session_id ?? storedId)

    if (resumed.info?.cwd) {
      setCurrentCwd(resumed.info.cwd)
    }
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

/**
 * Optimistically add a just-created session to the sidebar list + mark it active,
 * seeding the row's PREVIEW with the user's first message so `sessionTitle`
 * (title || preview || 'Untitled') shows it immediately — instead of the chat
 * being absent from the list and the header stuck on "New session". The backend's
 * async `session.title` event later patches `title` in place (see store/chat.ts),
 * superseding the first-message preview. Desktop parity (upsertOptimisticSession).
 */
export function registerNewSession(id: string, firstMessage: string): void {
  const now = Math.floor(Date.now() / 1000)
  const stub: SessionInfo = {
    // Seed the row's project directory (ensureSession just adopted the runtime's
    // resolved cwd) so re-opening this chat later restores the same directory,
    // and the sidebar can group it by workspace right away.
    cwd: $currentCwd.get().trim() || null,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: true,
    last_active: now,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: firstMessage.trim().slice(0, 200) || null,
    source: null,
    started_at: now,
    title: null,
    tool_call_count: 0
  }
  $sessions.set([stub, ...$sessions.get().filter(s => s.id !== id)])
  $activeStoredSessionId.set(id)
}

// STUB — the ported composer's `/resume` slash directive opens desktop's session
// picker overlay. Universal has no such overlay yet, so this is a no-op kept for
// import-site parity (composer-utils session-picker action). FLAG(chat-port).
export function setSessionPickerOpen(_open: boolean): void {
  /* no-op: session picker overlay not ported */
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
