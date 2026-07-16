import { StatusRow } from '@/components/chat/status-row'
import { StatusSection } from '@/components/chat/status-section'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ArrowUp, iconSize, Trash2 } from '@/lib/icons'

// Adapted from apps/desktop/src/app/chat/composer/queue-panel.tsx. Universal's
// queue is a plain string[] (no per-entry ids / attachments / in-place edit), so
// this drops the pencil-edit affordance — send-now + delete only.
// FLAG(chat-port): queued-prompt in-place editing is deferred (no rich queue store).

export function QueuePanel({
  busy,
  entries,
  onDelete,
  onSendNow
}: {
  busy: boolean
  entries: string[]
  onDelete: (index: number) => void
  onSendNow: (index: number) => void
}) {
  const { t } = useI18n()
  const c = t.composer

  if (entries.length === 0) {
    return null
  }

  return (
    <StatusSection
      icon={<Codicon className="text-muted-foreground/70" name="layers" size="0.8rem" />}
      label={c.queued(entries.length)}
    >
      {entries.map((entry, index) => (
        <StatusRow
          className="border border-transparent"
          key={`${index}-${entry}`}
          trailing={
            <>
              <Tip label={busy ? c.queueSendNext : c.queueSend}>
                <Button
                  aria-label={busy ? c.queueSendNext : c.queueSend}
                  className="size-5 rounded-md"
                  disabled={busy}
                  onClick={() => onSendNow(index)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <ArrowUp className={iconSize.xs} />
                </Button>
              </Tip>
              <Tip label={c.queueDelete}>
                <Button
                  aria-label={c.queueDelete}
                  className="size-5 rounded-md"
                  onClick={() => onDelete(index)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className={iconSize.xs} />
                </Button>
              </Tip>
            </>
          }
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-[0.73rem] leading-4 text-foreground/92">{entry.trim() || c.emptyTurn}</p>
          </div>
        </StatusRow>
      ))}
    </StatusSection>
  )
}
