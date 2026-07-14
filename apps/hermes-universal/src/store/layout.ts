import { atom, computed, type ReadableAtom } from '@/store/atom'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { arraysEqual, insertUniqueId } from '@/lib/storage'

import { $paneStates, ensurePaneRegistered, setPaneOpen, setPaneWidthOverride, togglePane } from './panes'

// Shell + left-sidebar layout state. Ported from desktop's `@/store/layout`,
// de-`desktop`-d to `hermes.*` storage keys. The chat-sidebar lives in the
// generic pane system (`store/panes.ts`); everything below (pins, section-open
// state, drag orders, grouping) is the sidebar's own persisted UI state.

export const SIDEBAR_DEFAULT_WIDTH = 237
export const SIDEBAR_MAX_WIDTH = 360
export const SIDEBAR_SESSIONS_PAGE_SIZE = 50

export const CHAT_SIDEBAR_PANE_ID = 'chat-sidebar'

ensurePaneRegistered(CHAT_SIDEBAR_PANE_ID, { open: true })

export const $sidebarOpen: ReadableAtom<boolean> = computed(
  $paneStates,
  states => states[CHAT_SIDEBAR_PANE_ID]?.open ?? true
)

export const $sidebarWidth: ReadableAtom<number> = computed($paneStates, states => {
  const override = states[CHAT_SIDEBAR_PANE_ID]?.widthOverride

  return typeof override === 'number' ? override : SIDEBAR_DEFAULT_WIDTH
})

// `panesFlipped` mirrors the sidebar to the right edge (parity with desktop's
// left/right swap). The titlebar swap button drives it; the shell reads it to
// pick the pane `side`.
export const $panesFlipped = persistentAtom<boolean>('hermes.panesFlipped', false, Codecs.bool)

export function togglePanesFlipped(): void {
  $panesFlipped.set(!$panesFlipped.get())
}

// Right-sidebar visibility placeholder (the right pane rework is a later step);
// the titlebar's right-sidebar toggle drives it.
export const $rightSidebarOpen = persistentAtom<boolean>('hermes.rightSidebarOpen', false, Codecs.bool)

export function toggleRightSidebar(): void {
  $rightSidebarOpen.set(!$rightSidebarOpen.get())
}

// ── Pinned sessions ─────────────────────────────────────────────────────────
export const $pinnedSessionIds = persistentAtom('hermes.pinnedSessions', [] as string[], Codecs.stringArray)

// ── Session / project / workspace drag orders ───────────────────────────────
export const $sidebarSessionOrderIds = persistentAtom('hermes.sessionOrder', [] as string[], Codecs.stringArray)
export const $sidebarSessionOrderManual = persistentAtom('hermes.sessionOrder.manual', false, Codecs.bool)
export const $sidebarWorkspaceOrderIds = persistentAtom('hermes.workspaceOrder', [] as string[], Codecs.stringArray)
// Order of the top-level repo "parent" groups in the worktree tree (worktrees
// within a parent reuse $sidebarWorkspaceOrderIds).
export const $sidebarWorkspaceParentOrderIds = persistentAtom(
  'hermes.workspaceParentOrder',
  [] as string[],
  Codecs.stringArray
)
// Manual drag-order of projects in the overview. Empty = the deterministic
// default sort; once the user drags a project their order wins.
export const $sidebarProjectOrderIds = persistentAtom('hermes.projectOrder', [] as string[], Codecs.stringArray)
// Repo/worktree nodes the user explicitly COLLAPSED. Absent = open.
export const $sidebarWorkspaceCollapsedIds = persistentAtom(
  'hermes.workspaceCollapsed',
  [] as string[],
  Codecs.stringArray
)
// Auto-derived (git-repo) projects dismissed from the overview (keyed by repo root).
export const $dismissedAutoProjectIds = persistentAtom(
  'hermes.dismissedAutoProjects',
  [] as string[],
  Codecs.stringArray
)
// Worktree rows hidden after a `git worktree remove` (keyed by worktree path).
export const $dismissedWorktreeIds = persistentAtom('hermes.dismissedWorktrees', [] as string[], Codecs.stringArray)

// ── Section open state ──────────────────────────────────────────────────────
export const $sidebarPinsOpen = atom(true)
export const $sidebarRecentsOpen = atom(true)
// Cron section collapsed by default (only renders when cron jobs exist).
export const $sidebarCronOpen = persistentAtom('hermes.sidebarCronOpen', false, Codecs.bool)
// Messaging platform sections collapse by default; we persist ids the user has
// explicitly expanded, so the default stays collapsed.
export const $sidebarMessagingOpenIds = persistentAtom('hermes.sidebarMessagingOpen', [] as string[], Codecs.stringArray)
export const $sidebarAgentsGrouped = persistentAtom('hermes.agentsGroupedByWorkspace', false, Codecs.bool)

// Set by the PaneShell hover-reveal overlay while the sidebar is collapsed; kept
// true the whole time it's a floating overlay so ChatSidebar mounts its rows
// off-screen, ready to slide.
export const $sidebarOverlayMounted = atom(false)
export const $isSidebarResizing = atom(false)
export const $sessionsLimit = atom(SIDEBAR_SESSIONS_PAGE_SIZE)

// ── Pane open/width helpers ─────────────────────────────────────────────────
export function setSidebarWidth(width: number) {
  const bounded = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_DEFAULT_WIDTH, width))
  setPaneWidthOverride(CHAT_SIDEBAR_PANE_ID, bounded)
}

export function setSidebarOpen(open: boolean) {
  setPaneOpen(CHAT_SIDEBAR_PANE_ID, open)
}

export function toggleSidebarOpen() {
  togglePane(CHAT_SIDEBAR_PANE_ID)
}

// ── Workspace node collapse / project dismissal ─────────────────────────────
export function toggleWorkspaceNodeCollapsed(id: string): void {
  const current = $sidebarWorkspaceCollapsedIds.get()

  $sidebarWorkspaceCollapsedIds.set(current.includes(id) ? current.filter(nodeId => nodeId !== id) : [...current, id])
}

export function dismissAutoProject(id: string): void {
  const current = $dismissedAutoProjectIds.get()

  if (!current.includes(id)) {
    $dismissedAutoProjectIds.set([...current, id])
  }
}

export function dismissWorktree(id: string): void {
  const current = $dismissedWorktreeIds.get()

  if (!current.includes(id)) {
    $dismissedWorktreeIds.set([...current, id])
  }
}

export function restoreWorktree(id: string): void {
  const current = $dismissedWorktreeIds.get()

  if (current.includes(id)) {
    $dismissedWorktreeIds.set(current.filter(worktreeId => worktreeId !== id))
  }
}

// ── Hotkey → focus the sessions search field ────────────────────────────────
// Opens the sidebar first, then lets the field (which only mounts when the
// sidebar is open) subscribe + focus.
export const SESSION_SEARCH_FOCUS_EVENT = 'hermes:focus-session-search'

// Flash the ⌘N hint on the New-session rail row when the shortcut fires.
export const NEW_SESSION_FLASH_EVENT = 'hermes:new-session-flash'

export function requestSessionSearchFocus() {
  setSidebarOpen(true)

  if (typeof window !== 'undefined') {
    window.setTimeout(() => window.dispatchEvent(new CustomEvent(SESSION_SEARCH_FOCUS_EVENT)), 0)
  }
}

// ── Section toggles ─────────────────────────────────────────────────────────
export function setSidebarPinsOpen(open: boolean) {
  $sidebarPinsOpen.set(open)
}

export function setSidebarOverlayMounted(mounted: boolean) {
  $sidebarOverlayMounted.set(mounted)
}

export function setSidebarRecentsOpen(open: boolean) {
  $sidebarRecentsOpen.set(open)
}

export function setSidebarCronOpen(open: boolean) {
  $sidebarCronOpen.set(open)
}

export function toggleSidebarMessagingOpen(sourceId: string) {
  const current = $sidebarMessagingOpenIds.get()

  $sidebarMessagingOpenIds.set(current.includes(sourceId) ? current.filter(id => id !== sourceId) : [...current, sourceId])
}

export function setSidebarAgentsGrouped(grouped: boolean) {
  $sidebarAgentsGrouped.set(grouped)
}

// ── Order setters (skip write when unchanged) ───────────────────────────────
export function setSidebarSessionOrderIds(ids: string[]) {
  if (!arraysEqual($sidebarSessionOrderIds.get(), ids)) {
    $sidebarSessionOrderIds.set(ids)
  }
}

export function setSidebarSessionOrderManual(manual: boolean) {
  if ($sidebarSessionOrderManual.get() !== manual) {
    $sidebarSessionOrderManual.set(manual)
  }
}

export function setSidebarWorkspaceOrderIds(ids: string[]) {
  if (!arraysEqual($sidebarWorkspaceOrderIds.get(), ids)) {
    $sidebarWorkspaceOrderIds.set(ids)
  }
}

export function setSidebarWorkspaceParentOrderIds(ids: string[]) {
  if (!arraysEqual($sidebarWorkspaceParentOrderIds.get(), ids)) {
    $sidebarWorkspaceParentOrderIds.set(ids)
  }
}

export function setSidebarProjectOrderIds(ids: string[]) {
  if (!arraysEqual($sidebarProjectOrderIds.get(), ids)) {
    $sidebarProjectOrderIds.set(ids)
  }
}

export function setSidebarResizing(resizing: boolean) {
  $isSidebarResizing.set(resizing)
}

// ── Pin mutations ───────────────────────────────────────────────────────────
export function pinSession(sessionId: string, index?: number) {
  const prev = $pinnedSessionIds.get()
  const next = insertUniqueId(prev, sessionId, index ?? prev.filter(id => id !== sessionId).length)

  if (!arraysEqual(prev, next)) {
    $pinnedSessionIds.set(next)
  }
}

export function unpinSession(sessionId: string) {
  const prev = $pinnedSessionIds.get()
  const next = prev.filter(id => id !== sessionId)

  if (!arraysEqual(prev, next)) {
    $pinnedSessionIds.set(next)
  }
}

// Replace the whole pinned order at once (drag-reorder hands back the new order).
// Keep only ids that are actually pinned so a stale row can't smuggle an
// unpinned id into the store.
export function setPinnedSessionOrder(ids: string[]) {
  const prev = $pinnedSessionIds.get()
  const pinned = new Set(prev)
  const next = ids.filter(id => pinned.has(id))

  if (next.length === prev.length && !arraysEqual(prev, next)) {
    $pinnedSessionIds.set(next)
  }
}

export function bumpSessionsLimit(step: number = SIDEBAR_SESSIONS_PAGE_SIZE) {
  const safeStep = Math.max(1, Math.floor(step))
  $sessionsLimit.set($sessionsLimit.get() + safeStep)
}

export function resetSessionsLimit() {
  if ($sessionsLimit.get() !== SIDEBAR_SESSIONS_PAGE_SIZE) {
    $sessionsLimit.set(SIDEBAR_SESSIONS_PAGE_SIZE)
  }
}
