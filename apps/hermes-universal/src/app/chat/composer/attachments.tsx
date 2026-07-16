import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import type { StagedAttachment } from '@/app/chat/attachments'
import { useI18n } from '@/i18n'
import { FileText, ImageIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

// Adapted from apps/desktop/src/app/chat/composer/attachments.tsx. Desktop's
// ComposerAttachment carries upload state / preview bytes / kind; universal
// stages a lean { ref, name } (the gateway `file.attach` ref spliced into the
// prompt), so this renders the same chip styling over the simpler shape. Preview
// on click is deferred (FIXME(chat-port)).

export function AttachmentList({
  attachments,
  onRemove
}: {
  attachments: StagedAttachment[]
  onRemove?: (index: number) => void
}) {
  return (
    <div className="flex max-w-full flex-wrap gap-1.5 px-1 pt-1" data-slot="composer-attachments">
      {attachments.map((attachment, index) => (
        <AttachmentPill attachment={attachment} index={index} key={`${attachment.ref}-${index}`} onRemove={onRemove} />
      ))}
    </div>
  )
}

function isImageRef(ref: string): boolean {
  return ref.startsWith('@image:') || /\.(png|jpe?g|gif|webp|svg)\b/i.test(ref)
}

function AttachmentPill({
  attachment,
  index,
  onRemove
}: {
  attachment: StagedAttachment
  index: number
  onRemove?: (index: number) => void
}) {
  const { t } = useI18n()
  const c = t.composer
  const Icon = isImageRef(attachment.ref) ? ImageIcon : FileText

  return (
    <Tip label={attachment.ref || attachment.name}>
      <div className="group/attachment relative min-w-0 shrink-0">
        <div
          className={cn(
            'flex max-w-56 items-center gap-2 rounded-2xl border border-border/60 bg-background/50 px-2 py-1.5 text-left',
            'shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]'
          )}
        >
          <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-border/55 bg-muted/35 text-muted-foreground">
            <Icon className="size-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[0.72rem] font-medium leading-4 text-foreground/90">
              {attachment.name}
            </span>
          </span>
        </div>
        {onRemove && (
          <button
            aria-label={c.removeAttachment(attachment.name)}
            className="absolute -right-1 -top-1 grid size-3.5 place-items-center rounded-full border border-border/70 bg-background text-muted-foreground opacity-0 shadow-xs transition hover:bg-accent hover:text-foreground group-hover/attachment:opacity-100 focus-visible:opacity-100"
            onClick={() => onRemove(index)}
            type="button"
          >
            <Codicon name="close" size="0.625rem" />
          </button>
        )}
      </div>
    </Tip>
  )
}
