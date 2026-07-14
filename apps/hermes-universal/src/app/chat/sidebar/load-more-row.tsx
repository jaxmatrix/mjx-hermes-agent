import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'

interface SidebarLoadMoreRowProps {
  step: number
  onClick: () => void
  loading?: boolean
}

// Compact "load more" affordance shared by recents, messaging, and cron. Ported
// from desktop `load-more-row.tsx` (GlyphSpinner → a spinning codicon).
export function SidebarLoadMoreRow({ step, onClick, loading = false }: SidebarLoadMoreRowProps) {
  const { t } = useI18n()
  const label = loading ? t.sidebar.loading : step > 0 ? t.sidebar.loadCount(step) : t.sidebar.loadMore

  return (
    <button
      aria-label={label}
      className="ml-auto grid size-5 place-items-center rounded-sm bg-transparent text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-(--ui-text-tertiary)"
      disabled={loading}
      onClick={onClick}
      type="button"
    >
      <Codicon className={loading ? 'animate-spin' : undefined} name={loading ? 'loading' : 'ellipsis'} size="0.75rem" />
    </button>
  )
}
