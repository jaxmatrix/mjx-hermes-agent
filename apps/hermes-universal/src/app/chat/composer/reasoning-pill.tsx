import { DEFAULT_REASONING_EFFORT } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { useModelMenuHost } from '@/app/shell/model-menu-host-context'
import { ModelMenuCloseContext } from '@/app/shell/model-menu-panel'
import { REASONING_EFFORTS } from '@/sdk'
import { useModelMenuController } from '@/app/shell/use-model-menu-controller'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { releaseTypingFocus } from '@/components/ui/keyboard-first'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ChevronDown, X } from '@/lib/icons'
import { IS_MOBILE } from '@/lib/platform'
import { reasoningEffortClamp, reasoningEffortLabel } from '@/lib/reasoning-effort'
import { cn } from '@/lib/utils'
import { $defaultReasoningEffort } from '@/store/session'

import type { ChatBarState } from './types'

const PILL = cn(
  'h-(--composer-control-size) shrink-0 gap-1 rounded-md px-2 text-xs font-normal',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)

const ROW = cn(
  'flex w-full items-center gap-3 px-4 text-start',
  'min-h-(--touch-target-min)',
  'hover:bg-(--ui-row-hover-background) active:bg-(--ui-row-hover-background)'
)

/**
 * Composer reasoning selector: the active model's effort level as its own
 * pill next to the model pill, opening the same Thinking / Fast / Effort rows
 * the catalog offers per model — without having to find the model's row and
 * hover its submenu. Hidden when the catalog says the model has no reasoning
 * control, and while there is no live menu (gateway closed).
 *
 * On mobile opens a bottom sheet of touch-sized effort rows (no hover submenu).
 *
 * Reads THIS surface's SessionView (primary or tile), like the model pill.
 */
export function ReasoningPill({ disabled, model }: { disabled: boolean; model: ChatBarState['model'] }) {
  const copy = useI18n().t.shell.modelOptions
  const view = useSessionView()
  const reasoningEffort = useStore(view.$reasoningEffort)
  const reasoningEffortWire = useStore(view.$reasoningEffortWire)
  const defaultEffort = useStore($defaultReasoningEffort)
  const [open, setOpen] = useState(false)
  const host = useModelMenuHost()

  if (!model.reasoningMenuContent || model.supportsReasoning === false) {
    return null
  }

  const effort = reasoningEffort || defaultEffort || DEFAULT_REASONING_EFFORT
  // A clamped pick (`ultra` → `max`) keeps the pill compact ("Ultra→Max") and
  // spells out the CLI's wording in the tooltip, so Ultra is never shown as a
  // distinct wire level the route does not have (#61634).
  const clamp = reasoningEffortClamp(effort, reasoningEffortWire)
  const label = reasoningEffortLabel(effort, reasoningEffortWire)

  const title = clamp
    ? `${copy.effort}: ${copy[clamp.effort]} (${copy.sendsOnRoute(copy[clamp.wire])})`
    : `${copy.effort}: ${label}`

  // Closing the menu ends its claim on the keyboard: Radix restores focus to
  // this pill (a toolbar button), so without the release the Enter that
  // committed a level also swallows whatever you type next.
  const setMenuOpen = (next: boolean) => {
    setOpen(next)

    if (!next) {
      releaseTypingFocus()
    }
  }

  if (IS_MOBILE && host) {
    return (
      <MobileReasoningPill
        disabled={disabled}
        host={host}
        label={label}
        open={open}
        setOpen={setMenuOpen}
        title={title}
      />
    )
  }

  return (
    <DropdownMenu onOpenChange={setMenuOpen} open={open}>
      <Tip label={title} side="top">
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={title}
            className={PILL}
            data-testid="reasoning-pill"
            disabled={disabled}
            type="button"
            variant="ghost"
          >
            <span>{label}</span>
            <ChevronDown className="size-2.5 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-52 p-0" side="top" sideOffset={8}>
        <ModelMenuCloseContext.Provider value={() => setMenuOpen(false)}>
          {model.reasoningMenuContent}
        </ModelMenuCloseContext.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MobileReasoningPill({
  disabled,
  host,
  label,
  open,
  setOpen,
  title
}: {
  disabled: boolean
  host: NonNullable<ReturnType<typeof useModelMenuHost>>
  label: string
  open: boolean
  setOpen: (open: boolean) => void
  title: string
}) {
  const common = useI18n().t.common
  const options = useI18n().t.shell.modelOptions
  const { controller } = useModelMenuController(host)
  const { effort, model, provider } = controller.current
  const levels = ['none', ...REASONING_EFFORTS]
  const selected = effort || DEFAULT_REASONING_EFFORT

  return (
    <>
      <Tip label={title} side="top">
        <Button
          aria-label={title}
          className={PILL}
          data-testid="reasoning-pill"
          disabled={disabled}
          onClick={() => setOpen(true)}
          type="button"
          variant="ghost"
        >
          <span>{label}</span>
          <ChevronDown className="size-2.5 shrink-0 opacity-50" />
        </Button>
      </Tip>
      <Sheet onOpenChange={setOpen} open={open}>
        <SheetContent
          className="flex max-h-[min(75vh,var(--visual-viewport-height,100vh))] flex-col gap-0 rounded-t-xl p-0 pb-[max(0.5rem,var(--safe-area-inset-bottom,0px))]"
          onOpenAutoFocus={event => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement | null)?.focus?.()
          }}
          showCloseButton={false}
          side="bottom"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border/65 px-2 py-1.5">
            <SheetTitle className="min-w-0 flex-1 truncate px-2 text-sm font-medium">{options.effort}</SheetTitle>
            <Button aria-label={common.close} onClick={() => setOpen(false)} size="icon" type="button" variant="ghost">
              <X className="size-5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
            {levels.map(level => {
              const isSelected = selected === level

              return (
                <button
                  className={ROW}
                  key={level}
                  onClick={() => {
                    void controller.setOptions({ effort: level }, { isActive: true, model, provider })
                    setOpen(false)
                  }}
                  type="button"
                >
                  <span className="w-4 shrink-0">
                    {isSelected ? <Codicon className="text-foreground" name="check" size="0.875rem" /> : null}
                  </span>
                  <span className="flex-1 text-sm">{reasoningEffortLabel(level) || options.medium}</span>
                </button>
              )
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
