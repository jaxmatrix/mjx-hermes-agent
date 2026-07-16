import { Fragment } from 'react'

import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { IconComponent } from '@/lib/icons'
import { cn } from '@/lib/utils'

// Trimmed port of apps/desktop/src/components/ui/tab-dropdown.tsx — just the
// `TabDropdown` used by OverlayNav's narrow collapse (no meta/count or the
// desktop ResponsiveTabs/TextTab deps the settings nav never uses).

export interface TabDropdownItem {
  active: boolean
  id: string
  icon?: IconComponent
  /** Indent as a sub-item (flattened nested nav). */
  indent?: boolean
  label: string
  onSelect: () => void
  /** Draw a separator above this item (group break). */
  separatorBefore?: boolean
}

function TabDropdownIcon({ icon: Icon, indent }: { icon: IconComponent; indent?: boolean }) {
  return <Icon className={cn('shrink-0 text-muted-foreground/80', indent ? 'size-3.5' : 'size-4')} />
}

/** A borderless "Label ⌄" trigger and a menu of labels — the single narrow-width
 *  collapse used by the settings overlay nav. */
export function TabDropdown({
  align = 'center',
  className,
  items
}: {
  align?: 'center' | 'end' | 'start'
  className?: string
  items: TabDropdownItem[]
}) {
  const active = items.find(item => item.active) ?? items[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-7 cursor-pointer items-center gap-1.5 px-1 text-[length:var(--conversation-caption-font-size)] font-medium text-foreground"
          type="button"
        >
          {active?.icon && <TabDropdownIcon icon={active.icon} indent={active.indent} />}
          <span className="min-w-0 truncate">{active?.label}</span>
          <Codicon className="text-muted-foreground" name="chevron-down" size="0.75rem" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={cn('w-44', className)} sideOffset={6}>
        {items.map((item, index) => (
          <Fragment key={item.id}>
            {item.separatorBefore && index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              className={cn(item.indent && 'pl-6', item.active && 'text-foreground')}
              onSelect={item.onSelect}
            >
              {item.icon && <TabDropdownIcon icon={item.icon} indent={item.indent} />}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
