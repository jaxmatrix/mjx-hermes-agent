import type { ComponentType, ReactNode } from 'react'

import { PAGE_INSET_X } from '@/app/layout-constants'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Ported to match apps/desktop/src/app/settings/primitives.tsx: the settings
// page scroll wrapper, section heading, and the canonical labeled-control row —
// keyed to the desktop `--conversation-*` typography + `--ui-*` tokens so every
// section reads identically to desktop.

export function SettingsContent({ children }: { children: ReactNode }) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto pb-20', PAGE_INSET_X)}>{children}</div>
}

export function Pill({ tone = 'muted', children }: { tone?: 'muted' | 'primary'; children: ReactNode }) {
  return <Badge variant={tone === 'primary' ? 'default' : 'muted'}>{children}</Badge>
}

export function SectionHeading({
  icon: Icon,
  title,
  meta
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  meta?: string
}) {
  return (
    <div className="mb-2.5 flex items-center gap-2 pt-2 text-[length:var(--conversation-text-font-size)] font-medium">
      <Icon className="size-4 text-muted-foreground" />
      <span>{title}</span>
      {meta && <Pill>{meta}</Pill>}
    </div>
  )
}

export function ListRow({
  title,
  description,
  hint,
  action,
  below,
  wide = false
}: {
  title: ReactNode
  description?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  below?: ReactNode
  wide?: boolean
}) {
  return (
    // Container-queried (not viewport): the label/control split keys on the row's
    // own pane width, so a narrow detail column stacks instead of squishing.
    <div className="@container">
      <div
        className={cn(
          'grid gap-3 py-3',
          !wide && '@2xl:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] @2xl:items-center'
        )}
      >
        <div className="min-w-0">
          <div className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">{title}</div>
          {description && (
            <div className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
              {description}
            </div>
          )}
          {hint && <div className="mt-1 block font-mono text-[0.68rem] text-muted-foreground/45">{hint}</div>}
          {below}
        </div>
        {action && <div className={cn('min-w-0', !wide && '@2xl:justify-self-end')}>{action}</div>}
      </div>
    </div>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-16 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && <div className="text-xs text-muted-foreground">{description}</div>}
    </div>
  )
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-muted-foreground">
      <span className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      <span className="text-sm">{label}</span>
    </div>
  )
}
