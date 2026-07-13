import type { ComponentType, ReactNode } from 'react'

import { cn } from '@/lib/utils'

// Adapted from apps/desktop/src/app/settings/primitives.tsx onto mobile tokens
// (bg-card / text-muted-foreground / plain text sizes instead of the desktop
// --conversation-* vars and Badge/PageLoader deps).

export function SettingsContent({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 [-webkit-overflow-scrolling:touch]">{children}</div>
  )
}

export function Pill({ tone = 'muted', children }: { tone?: 'muted' | 'primary'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium',
        tone === 'primary' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
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
    <div className="mb-2 flex items-center gap-2 pt-2 text-sm font-medium text-foreground">
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
    // own width, so a narrow detail column stacks instead of squishing the label.
    <div className="@container border-b border-border/60 last:border-b-0">
      <div
        className={cn('grid gap-2 py-3.5', !wide && '@md:grid-cols-[minmax(0,1fr)_minmax(11rem,18rem)] @md:items-center')}
      >
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</div>}
          {hint && <div className="mt-1 block font-mono text-[0.68rem] text-muted-foreground/50">{hint}</div>}
          {below}
        </div>
        {action && <div className={cn('min-w-0', !wide && '@md:justify-self-end')}>{action}</div>}
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
