import { Fragment } from 'react'

import { composerPanelCard } from '@/components/chat/composer-dock'
import { type CompletionEntry, displayText } from '@/app/chat/composer-completions'
import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

// Adapted from apps/desktop/src/app/chat/composer/{trigger-popover,completion-drawer}.tsx.
// Desktop drives this off assistant-ui's Unstable_TriggerItem adapter; universal
// feeds it its own CompletionEntry[] (RPC-backed), keeping the exact drawer skin.

const DRAWER_SHELL = cn(
  'absolute left-2 z-50 w-80 max-w-[calc(100%-1rem)] max-h-[min(22rem,calc(100vh-8rem))]',
  'overflow-y-auto overscroll-contain p-1 text-popover-foreground',
  composerPanelCard
)

export const COMPLETION_DRAWER_CLASS = cn(DRAWER_SHELL, 'bottom-full mb-1')
export const COMPLETION_DRAWER_BELOW_CLASS = cn(DRAWER_SHELL, 'top-full mt-1')

const AT_ICON_BY_TYPE: Record<string, string> = {
  diff: 'diff',
  file: 'book',
  folder: 'folder',
  git: 'git-branch',
  image: 'file-media',
  simple: 'symbol-misc',
  staged: 'diff-added',
  tool: 'tools',
  url: 'globe'
}

function atIcon(entry: CompletionEntry): string {
  const raw = entry.text
  if (raw.startsWith('@diff')) return AT_ICON_BY_TYPE.diff
  if (raw.startsWith('@staged')) return AT_ICON_BY_TYPE.staged
  if (raw.startsWith('@folder') || raw.endsWith('/')) return AT_ICON_BY_TYPE.folder
  if (raw.startsWith('@image') || /\.(png|jpe?g|gif|webp|svg)\b/i.test(raw)) return AT_ICON_BY_TYPE.image
  if (raw.startsWith('@url') || raw.startsWith('@http')) return AT_ICON_BY_TYPE.url
  return AT_ICON_BY_TYPE.file
}

const ROW_BASE_CLASS = [
  'relative flex w-full cursor-default select-none rounded-md px-2 py-1 text-left',
  'outline-hidden transition-colors hover:bg-(--ui-bg-tertiary)',
  'data-[highlighted]:bg-(--ui-bg-tertiary) data-[highlighted]:text-foreground'
].join(' ')

export function ComposerTriggerPopover({
  activeIndex,
  items,
  kind,
  loading,
  onHover,
  onPick,
  placement = 'top'
}: {
  activeIndex: number
  items: readonly CompletionEntry[]
  kind: '@' | '/'
  loading: boolean
  onHover: (index: number) => void
  onPick: (entry: CompletionEntry) => void
  placement?: 'bottom' | 'top'
}) {
  const { t } = useI18n()
  const copy = t.composer
  const isSlash = kind === '/'

  let lastGroup: string | undefined

  return (
    <div
      className={placement === 'bottom' ? COMPLETION_DRAWER_BELOW_CLASS : COMPLETION_DRAWER_CLASS}
      data-slot="composer-completion-drawer"
      data-state="open"
      onMouseDown={event => event.preventDefault()}
      role="listbox"
    >
      {items.length === 0 ? (
        loading ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-(--ui-text-tertiary)">
            <GlyphSpinner ariaLabel={copy.lookupLoading} className="text-foreground/70" spinner="braille" />
            <span>{copy.lookupLoading}</span>
          </div>
        ) : (
          <div className="px-3 py-3 text-xs text-(--ui-text-tertiary)">
            <p>{copy.lookupNoMatches}</p>
            <p className="mt-1 text-xs text-(--ui-text-tertiary)">
              {kind === '@' ? (
                <>
                  {copy.lookupTry} <span className="font-mono text-foreground/80">@file:</span> {copy.lookupOr}{' '}
                  <span className="font-mono text-foreground/80">@folder:</span>.
                </>
              ) : (
                <>
                  {copy.lookupTry} <span className="font-mono text-foreground/80">/help</span>.
                </>
              )}
            </p>
          </div>
        )
      ) : (
        items.map((entry, index) => {
          const display = displayText(entry)
          const group = entry.group?.trim()
          const showHeader = isSlash && Boolean(group) && group !== lastGroup
          const isFirstHeader = lastGroup === undefined
          lastGroup = group || lastGroup
          const active = index === activeIndex

          return (
            <Fragment key={`${entry.text}-${index}`}>
              {showHeader && (
                <div
                  className={cn(
                    'select-none px-2 pb-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)',
                    isFirstHeader ? 'pt-0.5' : 'pt-2'
                  )}
                >
                  {group}
                </div>
              )}
              <button
                className={cn(ROW_BASE_CLASS, isSlash ? 'flex-col gap-0' : 'items-center gap-2')}
                data-highlighted={active ? '' : undefined}
                onClick={() => onPick(entry)}
                onMouseEnter={() => onHover(index)}
                type="button"
              >
                {isSlash ? (
                  <span
                    className={cn(
                      'font-medium leading-snug text-foreground',
                      active ? 'whitespace-normal break-words' : 'truncate'
                    )}
                  >
                    {display}
                  </span>
                ) : (
                  <>
                    <span className="grid size-4 shrink-0 place-items-center text-(--ui-text-tertiary)">
                      <Codicon name={atIcon(entry)} size="0.875rem" />
                    </span>
                    <span className="min-w-0 shrink truncate font-mono font-medium leading-5 text-foreground">
                      {display}
                    </span>
                  </>
                )}
              </button>
            </Fragment>
          )
        })
      )}
    </div>
  )
}
