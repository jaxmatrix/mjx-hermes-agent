import { memo, type ReactNode } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { type Translations, useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { SubagentProgress } from '@/store/subagents'

// Adapted from apps/desktop/src/app/chat/composer/status-stack/status-row.tsx.
// Universal's status stack shows subagents (todos / background processes /
// terminals aren't wired here — FLAG(chat-port)), so this renders one
// SubagentProgress into the shared StatusRow.

const toolLabel = (name: string) =>
  name
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || name

function leadingGlyph(item: SubagentProgress, s: Translations['statusStack']): ReactNode {
  if (item.status === 'running') {
    return (
      <GlyphSpinner
        ariaLabel={s.running}
        className="text-[0.85rem] leading-none text-muted-foreground/80"
        spinner="braille"
      />
    )
  }

  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 rounded-full',
        item.status === 'failed' || item.status === 'interrupted' ? 'bg-destructive/80' : 'bg-emerald-500/70'
      )}
    />
  )
}

export const StatusItemRow = memo(function StatusItemRow({
  item,
  onOpen
}: {
  item: SubagentProgress
  onOpen?: () => void
}) {
  const { t } = useI18n()
  const s = t.statusStack
  const failed = item.status === 'failed' || item.status === 'interrupted'

  return (
    <StatusRow
      leading={leadingGlyph(item, s)}
      onActivate={onOpen}
      trailing={
        onOpen ? (
          <Codicon aria-hidden className="text-muted-foreground/55" name="link-external" size="0.85rem" />
        ) : undefined
      }
    >
      <span
        className={cn(
          'min-w-0 max-w-[18rem] truncate text-[0.73rem] leading-4',
          failed ? 'text-destructive/90' : 'text-foreground/92'
        )}
      >
        {item.goal || t.statusStack.subagents(1)}
      </span>
      {item.currentTool && (
        <span className="shrink-0 truncate text-[0.62rem] leading-4 text-muted-foreground/70">
          {toolLabel(item.currentTool)}
        </span>
      )}
    </StatusRow>
  )
})
