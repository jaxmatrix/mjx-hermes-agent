import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * Full-bleed affordance shown while files are dragged over the chat area (ported
 * from desktop's ChatDropOverlay, files-only). Always `pointer-events-none` so
 * the drop lands on the window underneath (Tauri claims it) — purely visual.
 */
export function ChatDropOverlay({ active }: { active: boolean }) {
  const { t } = useI18n()

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 z-40 flex items-center justify-center transition-opacity duration-150 ease-out',
        active ? 'opacity-100' : 'opacity-0'
      )}
      data-slot="chat-drop-overlay"
    >
      <div
        className={cn(
          'absolute inset-2 rounded-2xl border-2 border-dashed backdrop-blur-[2px] [-webkit-backdrop-filter:blur(2px)]',
          'border-[color-mix(in_srgb,var(--dt-composer-ring)_55%,transparent)] bg-[color-mix(in_srgb,var(--dt-card)_55%,transparent)]'
        )}
      />
      <span className="relative text-[11px] font-medium tracking-wide text-foreground uppercase">
        {t.composer.dropFiles}
      </span>
    </div>
  )
}
