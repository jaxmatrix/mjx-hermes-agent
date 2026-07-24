import {
  deleteSession,
  getSessionMessages,
  listAllProfileSessions,
  listSessions,
  renameSession,
  searchSessions,
  setSessionArchived
} from '@/hermes'
import { appendLiveSessionProjection, toChatMessages } from '@/lib/session-history'
import { stableArray } from '@/lib/stable-array'
import { atom, computed } from '@/store/atom'
import {
  $busy,
  $clarify,
  $currentCwd,
  $messages,
  $sessionId,
  $statusLine,
  resetChat,
  setCurrentCwd
} from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { $pinnedSessionIds, pinSession, unpinSession } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import { flashPetActivity } from '@/store/pet'
import { $sessionStates } from '@/store/session-state-types'
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

// Stored ids that finished a turn in the BACKGROUND (a tile, not the focused
// session) — the sidebar's "finished while you were away" marker. Written by
// `store/session-states.ts#handleTransition`; a view clears its id when seen.
export const $unreadFinishedSessionIds = atom<string[]>([])

export function clearUnreadFinishedSession(storedSessionId: string): void {
  const cur = $unreadFinishedSessionIds.get()

  if (cur.includes(storedSessionId)) {
    $unreadFinishedSessionIds.set(cur.filter(id => id !== storedSessionId))
  }
}

/** Follow a compression-driven stored-id rotation for the LIVE primary runtime
 *  (auto-compression mints a new session id mid-turn). Guarded by provenance so
 *  a stale background rotation can't steal the foreground selection. Called by
 *  `session-states.ts#handleTransition`. */
export function setActiveSessionStoredIdRotation(rotation: {
  nextStoredSessionId: string
  previousStoredSessionId: string
  runtimeSessionId: string
}): void {
  if (rotation.runtimeSessionId !== $sessionId.get()) {
    return
  }

  if ($activeStoredSessionId.get() !== rotation.previousStoredSessionId) {
    return
  }

  $activeStoredSessionId.set(rotation.nextStoredSessionId)
}

// Sidebar row state — the UNION of the primary (single active chat) and every
// open TILE. "working" = a session streaming a turn; "needs input" = a session
// with a clarify prompt pending. The tile slices come from `$sessionStates`
// (tiles only); the primary comes from the global `$busy`/`$clarify`. Guarded
// with `stableArray` so the per-token republish of `$sessionStates` doesn't
// re-render the sidebar unless membership actually changed.
let workingArr: readonly string[] = []
let workingSet = new Set<string>()
export const $workingSessionIds = computed(
  [$busy, $activeStoredSessionId, $sessionStates],
  (busy, activeId, states) => {
    const next: string[] = []

    if (busy && activeId) {
      next.push(activeId)
    }

    for (const s of Object.values(states)) {
      if (s.busy && s.storedSessionId && !next.includes(s.storedSessionId)) {
        next.push(s.storedSessionId)
      }
    }

    const stable = stableArray(workingArr, next)

    if (stable !== workingArr) {
      workingArr = stable
      workingSet = new Set(stable)
    }

    return workingSet
  }
)

let attentionArr: readonly string[] = []
export const $attentionSessionIds = computed(
  [$clarify, $activeStoredSessionId, $sessionStates],
  (clarify, activeId, states) => {
    const next: string[] = []

    if (clarify && activeId) {
      next.push(activeId)
    }

    for (const s of Object.values(states)) {
      if (s.needsInput && s.storedSessionId && !next.includes(s.storedSessionId)) {
        next.push(s.storedSessionId)
      }
    }

    return (attentionArr = stableArray(attentionArr, next))
  }
)

/** Title of the currently-viewed chat (title → first-message preview → ''),
 *  parity with desktop's `sessionTitle`. Empty for a fresh/unsaved chat — the
 *  titlebar / mobile header show their brand fallback then. Drives the topbar. */
export const $activeSessionTitle = computed([$sessions, $activeStoredSessionId], (sessions, activeId) => {
  if (!activeId) {
    return ''
  }

  const session = sessions.find(s => s.id === activeId)

  return session ? session.title?.trim() || session.preview?.trim() || '' : ''
})

/** Functional setter for optimistic row edits (rename dialog etc.). */
export function setSessions(updater: (prev: SessionInfo[]) => SessionInfo[]): void {
  $sessions.set(updater($sessions.get()))
}

/** Durable pin key: the lineage-root id survives auto-compression's id rotation. */
export function sessionPinId(session: SessionInfo): string {
  return session._lineage_root_id ?? session.id
}

/** True when a stored/lineage id resolves to this session — it matches either
 *  the live id or the stable lineage root (see sessionPinId). Verbatim from
 *  desktop store/session.ts. */
export const sessionMatchesStoredId = (
  session: Pick<SessionInfo, '_lineage_root_id' | 'id'>,
  storedSessionId: string
): boolean => session.id === storedSessionId || session._lineage_root_id === storedSessionId

/** Pin/unpin the active session — the `session.togglePin` keybind action.
 *  Adapted from desktop `app/contrib/wiring.tsx`; pins are keyed by the durable
 *  lineage id so the pin survives auto-compression. */
export function toggleSelectedPin(): void {
  const sessionId = $activeStoredSessionId.get()

  if (!sessionId) {
    return
  }

  const session = $sessions.get().find(s => sessionMatchesStoredId(s, sessionId))
  const pinId = session ? sessionPinId(session) : sessionId

  if ($pinnedSessionIds.get().includes(pinId)) {
    unpinSession(pinId)
  } else {
    pinSession(pinId)
  }
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

// Only the newest open may write chat state. Two async sources (the REST
// transcript + the resume RPC) mean a fast switch can land the SLOWER response
// of the chat you just left after the newer one already painted — desktop's
// `isCurrentResume` guard, in miniature.
let openGeneration = 0
const isCurrentOpen = (generation: number): boolean => generation === openGeneration

/**
 * Resume a stored session: hydrate its transcript + bind the runtime id.
 *
 * AUTHORITY: the transcript comes from the REST endpoint
 * (`GET /api/sessions/{id}/messages` → `db.get_messages`), NOT from the resume
 * RPC. `session.resume` returns a display-REDUCED history
 * (`_history_to_messages` in tui_gateway/server.py): assistant rows that only
 * made tool calls are dropped outright — taking that step's reasoning with them
 * — and each tool result is flattened to `{role, name, context}` with no
 * `tool_call_id` and no output. Hydrating from it lost every intermediate
 * thinking block and collapsed repeated same-name tool calls into one row.
 * The resume payload is still what binds the runtime id, the cwd, and the
 * in-flight turn; its messages are only a fallback when REST is unavailable.
 */
export async function openSession(storedId: string): Promise<void> {
  const generation = ++openGeneration

  $activeStoredSessionId.set(storedId)
  $messages.set([])
  $busy.set(true)
  $statusLine.set('')
  // Each stored session carries the project directory it runs in. Restore it up
  // front from the list row so the statusbar / file tree switch with the chat
  // immediately; the resume response's runtime info supersedes it below with the
  // authoritative value. (A cwd-less row settles to '' — a detached chat — which
  // is the correct final state, not a flicker; the files-tree white flash is
  // handled where it belongs, in use-project-tree.)
  setCurrentCwd($sessions.get().find(session => session.id === storedId)?.cwd)
  // A session resumed MID-TURN stays busy: the committed transcript ends before
  // the running turn, and `inflight` carries its tail. Settle to idle otherwise.
  let stillRunning = false

  // The REST transcript and the resume RPC are independent, so run them
  // concurrently (desktop does the same): wall time is max(), not sum, and the
  // transcript paints as soon as it lands instead of waiting on the agent build.
  // `.then(...)` rather than a bare call so a synchronous throw inside the REST
  // client can't take the resume down with it.
  const transcriptPromise = Promise.resolve()
    .then(() => getSessionMessages(storedId))
    .catch(() => null)

  const resumePromise = requestGateway<SessionResumeResponse>('session.resume', {
    session_id: storedId,
    cols: 96
  })

  // The rejection is consumed by the `await` below; this only keeps it from
  // surfacing as an unhandled rejection while the transcript fetch settles.
  resumePromise.catch(() => undefined)

  try {
    const transcript = await transcriptPromise
    const hydrated = transcript?.messages?.length ? toChatMessages(transcript.messages) : []
    // Only treat REST as the authority when it actually yielded a transcript —
    // an empty result falls through to the resume payload rather than painting
    // an empty chat.
    const restMessages = hydrated.length ? hydrated : null

    if (restMessages && isCurrentOpen(generation)) {
      $messages.set(restMessages)
    }

    const resumed = await resumePromise

    if (!isCurrentOpen(generation)) {
      return
    }

    // Project the still-running turn onto the committed transcript, so its
    // pending assistant exists for the live reducer to keep filling — otherwise
    // the turn's remaining tool events land in a fresh bubble that never settles.
    // The REST transcript is the authority when we have it (see AUTHORITY note).
    $messages.set(appendLiveSessionProjection(restMessages ?? toChatMessages(resumed.messages ?? []), resumed))
    $sessionId.set(resumed.session_id ?? storedId)
    stillRunning = Boolean(resumed.inflight?.streaming ?? resumed.running)

    if (resumed.info?.cwd) {
      setCurrentCwd(resumed.info.cwd)
    }
  } catch (err) {
    if (!isCurrentOpen(generation)) {
      return
    }

    // The resume RPC failed. Fall back to the REST transcript alone (already
    // painted above when it resolved) so the chat at least shows its history,
    // with no live runtime binding.
    const transcript = await transcriptPromise

    if (transcript) {
      $messages.set(toChatMessages(transcript.messages ?? []))
      $sessionId.set(storedId)
    } else {
      $statusLine.set(err instanceof Error ? err.message : 'Failed to open session')
    }
  } finally {
    if (isCurrentOpen(generation)) {
      $busy.set(stillRunning)
    }
  }
}

export function newSession(): void {
  resetChat()
  $activeStoredSessionId.set(null)
  flashPetActivity({ greeting: true }) // pet: wave hello on a fresh chat
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

  if ($activeStoredSessionId.get() === id) {
    newSession()
  }

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

  if ($activeStoredSessionId.get() === id) {
    newSession()
  }

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
