import { type ReactNode, type RefObject, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { Search } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface SearchFieldProps {
  placeholder: string
  value: string
  onChange: (value: string) => void
  /**
   * Data-driven placeholder suggestions — one picked at random per mount. Falls
   * back to `placeholder` when absent/empty.
   */
  hints?: string[]
  containerClassName?: string
  inputClassName?: string
  loading?: boolean
  onClear?: () => void
  inputRef?: RefObject<HTMLInputElement | null>
  trailingAction?: ReactNode
  'aria-label'?: string
}

/**
 * Shared search field (ported from desktop `components/ui/search-field.tsx`). No
 * box — borderless until focus, then an underline. Rests at low opacity until
 * focused or filled. Width/placement come from `containerClassName`.
 */
export function SearchField({
  placeholder,
  value,
  onChange,
  hints,
  containerClassName,
  inputClassName,
  loading = false,
  onClear,
  inputRef,
  trailingAction,
  'aria-label': ariaLabel
}: SearchFieldProps) {
  const { t } = useI18n()
  const clear = onClear ?? (() => onChange(''))

  // One hint per mount, picked at random — fresh nudge every visit.
  const [hintIndex] = useState(() => Math.floor(Math.random() * 4096))
  const hintCount = hints?.length ?? 0
  const effectivePlaceholder = hintCount > 0 ? hints![hintIndex % hintCount] : placeholder

  return (
    <div
      className={cn(
        // min-w-0 is load-bearing: without it the content-sized input sets the
        // container's flex min-width and bulldozes its siblings.
        'inline-flex min-w-0 max-w-full items-center gap-1.5 border-b border-transparent px-0.5 transition-[color,border-color,opacity]',
        !value && 'opacity-30 focus-within:opacity-100',
        containerClassName
      )}
    >
      <Search className="pointer-events-none size-3.5 shrink-0 text-muted-foreground/70" />
      <input
        aria-label={ariaLabel ?? placeholder}
        className={cn(
          'h-7 min-w-0 max-w-full bg-transparent text-xs text-foreground [field-sizing:content] placeholder:text-muted-foreground focus:outline-none',
          inputClassName
        )}
        onChange={event => onChange(event.target.value)}
        placeholder={effectivePlaceholder}
        ref={inputRef}
        type="text"
        value={value}
      />
      {trailingAction}
      {loading ? (
        <Codicon className="pointer-events-none shrink-0 animate-spin text-muted-foreground/70" name="loading" size="0.875rem" />
      ) : value ? (
        <Button
          aria-label={t.sidebar.clearSearch}
          className="shrink-0 text-muted-foreground/85 hover:bg-accent/60 hover:text-foreground"
          onClick={clear}
          size="icon-xs"
          variant="ghost"
        >
          <Codicon name="close" size="0.875rem" />
        </Button>
      ) : null}
    </div>
  )
}
