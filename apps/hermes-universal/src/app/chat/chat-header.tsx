import { SessionActionsMenu, SessionContextMenu } from '@/app/chat/sidebar/session-actions-menu'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { TitleMenuTrigger } from '@/components/ui/title-menu-trigger'
import { IS_DESKTOP } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $liveSessionTitle, $sessionId } from '@/store/chat'
import {
  $leftEdgeOpen,
  $panesFlipped,
  $pinnedSessionIds,
  $terminalOpen,
  pinSession,
  unpinSession
} from '@/store/layout'
import { $reviewOpen } from '@/store/review'
import { $activeStoredSessionId, $sessions, archiveSessionLocal, deleteSessionLocal, sessionPinId } from '@/store/session'

// The chat title header — ported from desktop's in-pane ChatHeader
// (apps/desktop/src/app/chat/index.tsx + `titlebarHeaderBaseClass`). It's the
// chat column's top row, so it tracks the chat pane horizontally (moves with the
// left sidebar) and is chat-only (absent on other routes). The title is a
// clickable pill opening the session menu (Rename/Pin/Archive/Delete).
//
// On desktop it's pulled UP (negative margin) into the reserved
// pt-(--titlebar-height) band so it aligns with the window-controls bar rather
// than stacking below it. On the empty new-session view (no session at all) it
// renders nothing (desktop parity — the intro extends up).
const HEADER_CLASS =
  'relative z-3 flex h-(--titlebar-height) w-full min-w-0 shrink-0 items-center justify-start gap-2 overflow-hidden border-b border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background)'

// Width of the window's left toggle cluster (sidebar-left / swap / search) plus
// the titlebar's own px-2 — the title must clear it when the chat pane reaches
// the window's left edge (nothing docked on that side).
//   0.5rem (titlebar px-2) + 3 × 1.25rem (size-5 buttons) + 2 × 0.125rem (gap-0.5)
//   = 4.5rem. The value below keeps well clear of that — it also covers the
//   size-7 buttons this cluster used to carry — so the title pill never touches
//   the search icon. Re-do the sum if a button joins the cluster or changes size
//   in `app/shell/titlebar-button.tsx` / `app/shell/titlebar.tsx`.
const LEFT_CLUSTER_INSET = 'pl-[6.75rem]'

export function ChatHeader() {
  const activeId = useStore($activeStoredSessionId)
  const runtimeSessionId = useStore($sessionId)
  const sessions = useStore($sessions)
  const pinnedIds = useStore($pinnedSessionIds)
  const liveTitle = useStore($liveSessionTitle)
  // POSITIONAL, like the titlebar toggles: what matters is whether ANY pane sits
  // on the window's LEFT edge, not whether the chat sidebar is open. Flipped,
  // every right-rail column docks left of chat — the review pane opens
  // independently of the file rails, and the terminal becomes a left column while
  // those rails are closed (see `app/shell/sidebar.tsx` terminalColumnActive).
  const leftEdgeOpen = useStore($leftEdgeOpen)
  const panesFlipped = useStore($panesFlipped)
  const reviewOpen = useStore($reviewOpen)
  const terminalOpen = useStore($terminalOpen)
  const leftColumnOpen = leftEdgeOpen || (panesFlipped && (reviewOpen || terminalOpen))

  // Empty new-session view (no stored AND no runtime session): show nothing, so
  // the intro fills the top band (desktop's ChatHeader returns null here).
  if (!activeId && !runtimeSessionId) {
    return null
  }

  // Resolve the active session by its STORED id (resumed sessions) OR the live
  // RUNTIME id (a new session that has since been added to the list, e.g. after
  // the auto-title refresh). Looking up by runtime id is what lets the header
  // pick up the title once the session lands in `sessions` — the sidebar already
  // renders it, but the header was only keyed on $activeStoredSessionId (null for
  // a new session), so it stayed "New session".
  const lookupId = activeId ?? runtimeSessionId
  const session = lookupId ? sessions.find(s => s.id === lookupId) : null
  // Until the session is in `sessions`, fall back to the live auto-title (pushed
  // by the backend's session.title event) so the heading stops saying "New
  // session" as soon as the title lands.
  const title = session
    ? session.title?.trim() || session.preview?.trim() || 'Untitled'
    : liveTitle.trim() || 'New session'

  // Pull into the reserved titlebar band on desktop; clear the left toggle
  // cluster only when nothing is docked on the left edge (else the cluster sits
  // over that pane, not the chat).
  const headerClass = cn(
    HEADER_CLASS,
    IS_DESKTOP && 'mt-[calc(-1*var(--titlebar-height))]',
    IS_DESKTOP && !leftColumnOpen ? LEFT_CLUSTER_INSET : 'pl-3',
    'pr-3'
  )

  const titleNode = !session ? (
    <span className="inline-flex h-6 max-w-full items-center truncate px-2 text-[0.75rem] font-medium leading-none text-(--ui-text-tertiary)">
      {title}
    </span>
  ) : (
    (() => {
      const pinId = sessionPinId(session)
      const isPinned = pinnedIds.includes(pinId)
      const actions = {
        sessionId: session.id,
        title,
        pinned: isPinned,
        onArchive: () => void archiveSessionLocal(session.id),
        onDelete: () => void deleteSessionLocal(session.id),
        onPin: () => (isPinned ? unpinSession(pinId) : pinSession(pinId))
      }

      return (
        <SessionContextMenu {...actions}>
          {/* Real element for the context-menu trigger (SessionActionsMenu is a
              fragment). The pill inside is the click/dropdown trigger. */}
          <span className="inline-flex min-w-0 max-w-full">
            <SessionActionsMenu {...actions}>
              <TitleMenuTrigger>{title}</TitleMenuTrigger>
            </SessionActionsMenu>
          </span>
        </SessionContextMenu>
      )
    })()
  )

  return (
    <header className={headerClass}>
      {!IS_DESKTOP && <SidebarTrigger className="shrink-0" />}
      <div className="min-w-0 flex-1 overflow-hidden">{titleNode}</div>
    </header>
  )
}
