import type { ReactNode } from 'react'

import { shellSidebarSurface } from '@/app/shell/cva/tokens'
import { NAV_ROW_ACTIVE, NAV_ROW_ICON } from '@/app/shell/nav-row'
import { Codicon } from '@/components/ui/codicon'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

export interface MobileNavRailItem {
  active?: boolean
  icon: string
  id: string
  /** Visible caption under the icon (may be short). */
  label: string
  /** Accessible name; defaults to `label` when omitted. */
  ariaLabel?: string
  onSelect: () => void
}

/** At this count and below, items share the full rail width; above, they scroll. */
const FILL_MAX = 4

/**
 * Horizontal bottom rail — Sessions (SIDEBAR_NAV) and Workspace (Control /
 * Workspace). Shared button chrome so both sides look the same; ≤4 fill,
 * >4 scroll at 25%-rail cell width.
 */
export function MobileNavRail({
  'aria-label': ariaLabel,
  items,
  leading
}: {
  'aria-label': string
  items: readonly MobileNavRailItem[]
  leading?: ReactNode
}) {
  const fill = items.length <= FILL_MAX

  return (
    <nav
      aria-label={ariaLabel}
      className={cn('shrink-0 border-t', shellSidebarSurface)}
      data-slot="mobile-nav-rail"
      style={{ paddingBottom: 'var(--safe-area-inset-bottom, 0px)' }}
    >
      <div
        className={cn(
          'flex items-stretch gap-0.5 px-1 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          fill ? 'w-full' : 'overflow-x-auto'
        )}
      >
        {leading}
        {items.map(item => (
          <button
            aria-current={item.active ? 'page' : undefined}
            aria-label={item.ariaLabel ?? item.label}
            className={cn(
              'flex min-h-12 flex-col items-center justify-center gap-1 rounded-md border border-transparent px-1 py-2',
              'text-sm font-medium transition-colors duration-100 ease-out',
              fill ? 'min-w-0 flex-1' : 'min-w-[25%] shrink-0 basis-1/4',
              item.active
                ? NAV_ROW_ACTIVE
                : 'text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground hover:transition-none'
            )}
            data-fill={fill ? 'true' : 'false'}
            key={item.id}
            onClick={() => {
              triggerHaptic('selection')
              item.onSelect()
            }}
            type="button"
          >
            <span className={NAV_ROW_ICON}>
              <Codicon name={item.icon} size="1.125rem" />
            </span>
            <span className="max-w-full truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
