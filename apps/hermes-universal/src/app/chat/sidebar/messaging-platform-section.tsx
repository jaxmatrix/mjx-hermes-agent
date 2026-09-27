/**
 * Messaging platform section with near-bottom reveal (+ optional API deepen).
 */

import { useCallback, useState, type ComponentProps, type ReactNode } from 'react'

import { PlatformAvatar } from '@/app/messaging/platform-icon'
import type { SessionInfo } from '@/types/hermes'

import { SidebarSessionsSection } from './sessions-section'
import { useNearBottomLoad } from './use-near-bottom-load'

const INITIAL_SHOWN = 3
const REVEAL_STEP = 10

type MessagingRowHandlers = Pick<
  ComponentProps<typeof SidebarSessionsSection>,
  | 'activeSessionId'
  | 'onArchiveSession'
  | 'onBranchSession'
  | 'onDeleteSession'
  | 'onResumeSession'
  | 'onTogglePin'
  | 'onToggleUnread'
  | 'dndSensors'
>

export function MessagingPlatformSection({
  group,
  contentClassName,
  rootClassName,
  open,
  onToggle,
  onRevealExhausted,
  loadingMore = false,
  rowHandlers,
  labelMeta
}: {
  group: { sourceId: string; label: string; sessions: SessionInfo[]; hasMore?: boolean; total?: number }
  contentClassName: string
  rootClassName?: string
  open: boolean
  onToggle: () => void
  /** Called when the local window catches up to loaded rows and the backend may have more. */
  onRevealExhausted?: () => void
  loadingMore?: boolean
  rowHandlers: MessagingRowHandlers
  labelMeta?: ReactNode
}) {
  const [shown, setShown] = useState(INITIAL_SHOWN)
  const canReveal = group.sessions.length > shown || Boolean(group.hasMore)

  const grow = useCallback(() => {
    setShown(prev => {
      const next = prev + REVEAL_STEP

      if (next >= group.sessions.length && group.hasMore) {
        onRevealExhausted?.()
      }

      return next
    })
  }, [group.hasMore, group.sessions.length, onRevealExhausted])

  const onContentScroll = useNearBottomLoad({
    hasMore: open && canReveal,
    loadGeneration: shown,
    loading: loadingMore,
    onLoadMore: grow
  })

  return (
    <SidebarSessionsSection
      {...rowHandlers}
      contentClassName={contentClassName}
      emptyState={null}
      footer={null}
      label={group.label}
      labelIcon={
        <PlatformAvatar
          className="size-4 rounded-[4px] text-[0.5625rem] [&_svg]:size-3"
          platformId={group.sourceId}
          platformName={group.label}
        />
      }
      labelMeta={labelMeta}
      onContentScroll={onContentScroll}
      onToggle={onToggle}
      open={open}
      pinned={false}
      rootClassName={rootClassName}
      sessions={group.sessions.slice(0, shown)}
    />
  )
}
