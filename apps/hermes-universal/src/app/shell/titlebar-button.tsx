import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Shared titlebar/window-control button. Matches desktop's `titlebarButtonClass`:
// transparent fill, muted-foreground/85 idle icon, control-hover fill + full
// foreground on hover. Compact (desktop titlebar density). `active` reflects a
// toggle (aria-pressed + a persistent control-active fill).
export function TitlebarButton({
  label,
  onClick,
  active = false,
  className,
  children
}: {
  label: string
  onClick: () => void
  active?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <Button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'size-7 rounded-[4px] bg-transparent text-muted-foreground/85 [&_.codicon]:text-[0.875rem] hover:bg-[var(--ui-control-hover-background)] hover:text-foreground',
        active && 'bg-[var(--ui-control-active-background)] text-foreground',
        className
      )}
      onClick={onClick}
      title={label}
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  )
}
