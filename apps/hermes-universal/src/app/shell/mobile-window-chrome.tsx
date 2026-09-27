import type { ReactNode } from 'react'

import { TitlebarButton } from '@/app/shell/titlebar-button'
import { Codicon } from '@/components/ui/codicon'
import { PaneTab, PaneTabLabel, PaneTabStrip } from '@/components/ui/pane-tab'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

export interface MobileWindowTab {
  id: string
  label: string
}

/**
 * Full-height phone window chrome: optional primary tab strip, close ✕, body,
 * optional bottom rail. Top bar always matches chat `MobileChromeBar`
 * (h-12 + safe-area) so body content sits below the chrome for every page —
 * tabs are optional inside that band; without them the row is close-only.
 * ✕ uses the same mobile titlebar density as the chat shell.
 */
export function MobileWindowChrome({
  activeTabId,
  body,
  bottom,
  className,
  closeSide = 'end',
  onClose,
  onSelectTab,
  secondary,
  tabs,
  topBorder = true,
  'data-slot': dataSlot = 'mobile-window'
}: {
  activeTabId?: string
  body: ReactNode
  bottom?: ReactNode
  className?: string
  /** Sessions: end (trailing). Workspace: start (leading). */
  closeSide?: 'end' | 'start'
  onClose: () => void
  onSelectTab?: (id: string) => void
  /** Optional second strip under the top bar (stories / nested chrome). */
  secondary?: ReactNode
  tabs?: readonly MobileWindowTab[]
  /** When false, omit the top bar’s bottom edge (Workspace). Default true. */
  topBorder?: boolean
  'data-slot'?: string
}) {
  const { t } = useI18n()
  const closeAtStart = closeSide === 'start'
  const tabList = tabs?.length && onSelectTab ? tabs : null

  const closeButton = (
    <TitlebarButton density="mobile" label={t.common.close} onClick={onClose}>
      <Codicon name="close" size="1.4rem" />
    </TitlebarButton>
  )

  const closeSlot = (
    <div
      className={cn(
        'absolute top-0 z-10 flex h-12 items-center',
        closeAtStart ? 'start-0 ps-1' : 'end-0 pe-1'
      )}
    >
      {closeButton}
    </div>
  )

  return (
    <div
      className={cn(
        // Solid sidebar seed — not `--ui-sidebar-surface-background`, which
        // glass clears to transparent. Seed stays opaque so chat underneath
        // stays masked without `data-glass-opaque` (that rule forces chrome).
        'relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-(--ui-bg-sidebar)',
        className
      )}
      data-slot={dataSlot}
      style={{
        paddingLeft: 'var(--safe-area-inset-left, 0px)',
        paddingRight: 'var(--safe-area-inset-right, 0px)'
      }}
    >
      <div
        className={cn('shrink-0', topBorder && 'border-b border-(--ui-stroke-tertiary)')}
        data-slot="mobile-window-top"
        style={{ paddingTop: 'var(--safe-area-inset-top, 0px)' }}
      >
        <div className="relative flex h-12 min-w-0 items-center" data-top-bar="">
          {tabList && onSelectTab ? (
            <PaneTabStrip
              className={cn('min-h-12 min-w-0', closeAtStart ? 'ps-12' : 'pe-12')}
              titlebar
            >
              {tabList.map(tab => (
                <PaneTab
                  active={tab.id === activeTabId}
                  data-tree-tab={tab.id}
                  key={tab.id}
                  onClick={() => onSelectTab(tab.id)}
                  role="tab"
                >
                  <PaneTabLabel
                    as="button"
                    className="text-sm font-medium normal-case tracking-normal"
                    type="button"
                  >
                    {tab.label}
                  </PaneTabLabel>
                </PaneTab>
              ))}
            </PaneTabStrip>
          ) : (
            // Close-only band: reserve the same horizontal inset the tab strip
            // uses so the ✕ never sits under a future leading control.
            <div className={cn('min-h-12 min-w-0 flex-1', closeAtStart ? 'ps-12' : 'pe-12')} />
          )}
          {closeSlot}
        </div>
      </div>

      {secondary}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>

      {bottom != null ? <div className="shrink-0">{bottom}</div> : null}
    </div>
  )
}
