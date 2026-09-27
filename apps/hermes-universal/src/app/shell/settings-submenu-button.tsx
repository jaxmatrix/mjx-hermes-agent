import { useRef, useState } from 'react'

import { topBarBottom, TopDrawer, TopDrawerRow } from '@/components/ui/top-drawer'
import { cn } from '@/lib/utils'

export interface SettingsSubmenuOption {
  id: string
  label: string
}

/**
 * Profile-style section picker for Workspace Settings groups that have nav
 * children (Providers, Keys). Lists every option including the current one —
 * the trigger is the current label; the drawer must not hide it.
 */
export function SettingsSubmenuButton({
  onSelect,
  options,
  selectedId,
  title
}: {
  onSelect: (id: string) => void
  options: readonly SettingsSubmenuOption[]
  selectedId: string
  title: string
}) {
  const [open, setOpen] = useState(false)
  const [offsetTop, setOffsetTop] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const selected = options.find(option => option.id === selectedId) ?? options[0]

  if (!selected || options.length === 0) {
    return null
  }

  return (
    <div className="shrink-0 border-b border-(--ui-stroke-tertiary) px-2 py-1.5" data-top-bar="">
      <button
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm',
          'hover:bg-[var(--ui-control-hover-background)]'
        )}
        data-slot="settings-submenu-trigger"
        onClick={() => {
          setOffsetTop(topBarBottom(triggerRef.current))
          setOpen(true)
        }}
        ref={triggerRef}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate font-medium">{selected.label}</span>
        <span className="text-muted-foreground text-xs">▾</span>
      </button>

      <TopDrawer offsetTop={offsetTop} onOpenChange={setOpen} open={open} title={title}>
        {options.map(option => (
          <TopDrawerRow
            active={option.id === selected.id}
            key={option.id}
            onSelect={() => {
              onSelect(option.id)
              setOpen(false)
            }}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </TopDrawerRow>
        ))}
      </TopDrawer>
    </div>
  )
}
