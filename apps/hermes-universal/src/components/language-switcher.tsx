import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { type Locale, LOCALE_OPTIONS, useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Check, ChevronDown, Globe } from '@/lib/icons'
import { cn } from '@/lib/utils'

// Adapted from apps/desktop/src/components/language-switcher.tsx. Trimmed for
// mobile: only four locales, so we drop cmdk search/Popover in favour of the
// ported DropdownMenu, and drop the isSavingLocale/notifyError paths — mobile
// setLocale just writes a persistentAtom and can't throw. Order follows the
// curated LOCALE_OPTIONS (en → zh → zh-hant → ja).

export interface LanguageSwitcherProps {
  className?: string
  // Icon-only trigger (e.g. a collapsed rail).
  collapsed?: boolean
}

export function LanguageSwitcher({ className, collapsed = false }: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n()
  const current = LOCALE_OPTIONS.find(option => option.id === locale) ?? LOCALE_OPTIONS[0]
  const title = t.language.switchTo

  const selectLocale = (code: Locale) => {
    if (code !== locale) {
      triggerHaptic('selection')
      void setLocale(code)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={title}
        className={cn(
          'inline-flex min-w-32 items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground',
          collapsed && 'min-w-0 px-2',
          className
        )}
        title={title}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <Globe className="size-4 shrink-0" />
          {!collapsed && <span className="truncate">{current.name}</span>}
        </span>
        {!collapsed && <ChevronDown className="size-3.5 shrink-0 opacity-70" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {LOCALE_OPTIONS.map(option => {
          const selected = option.id === locale

          return (
            <DropdownMenuItem
              className={cn(selected ? 'font-medium text-foreground' : 'text-muted-foreground')}
              key={option.id}
              onSelect={() => selectLocale(option.id as Locale)}
            >
              <Check className={cn('size-4 shrink-0 text-primary', !selected && 'invisible')} />
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              <span className="font-mono text-[0.65rem] text-muted-foreground uppercase">{option.id}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
