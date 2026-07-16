import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { Tip } from '@/components/ui/tooltip'
import { getGlobalModelInfo, getGlobalModelOptions, setGlobalModel } from '@/hermes'
import { useI18n } from '@/i18n'
import { Check, ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $connection } from '@/store/connection'

// Adapted from apps/desktop/src/app/chat/composer/model-pill.tsx. Desktop binds
// to a live per-session `model.options` stream; universal has only GLOBAL model
// config (/api/model/info + /api/model/options + /api/model/set), so this pill
// reflects the global assignment. FLAG(chat-port): there is no live per-session
// model streaming status here — the label refreshes on mount / connection.

interface FlatOption {
  provider: string
  providerLabel: string
  model: string
}

const PILL = cn(
  'h-(--composer-control-size) max-w-40 shrink-0 gap-1 rounded-md px-2 text-xs font-normal',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)

export function ModelPill({ compact = false, disabled }: { compact?: boolean; disabled: boolean }) {
  const copy = useI18n().t.shell.statusbar
  const connection = useStore($connection)
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState('')
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<FlatOption[] | null>(null)

  // Resolve the global model a beat after the gateway comes up; re-resolve when
  // the connection identity changes.
  useEffect(() => {
    let alive = true
    void getGlobalModelInfo()
      .then(info => {
        if (alive) {
          setModel(info.model || '')
          setProvider(info.provider || '')
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [connection])

  // Lazy-load the option list the first time the menu opens.
  useEffect(() => {
    if (!open || options) return
    let alive = true
    void getGlobalModelOptions()
      .then(res => {
        if (!alive) return
        const flat: FlatOption[] = []
        for (const p of res.providers ?? []) {
          for (const m of p.models ?? []) {
            flat.push({ provider: p.slug, providerLabel: p.name, model: m })
          }
        }
        setOptions(flat)
      })
      .catch(() => alive && setOptions([]))
    return () => {
      alive = false
    }
  }, [open, options])

  async function pick(option: FlatOption) {
    setOpen(false)
    setModel(option.model)
    setProvider(option.provider)
    try {
      await setGlobalModel(option.provider, option.model)
    } catch {
      /* keep the optimistic label; a failed set surfaces on next refresh */
    }
  }

  const label = compact ? (
    <ChevronDown className="size-3.5 shrink-0 opacity-70" />
  ) : (
    <>
      {model.trim() ? (
        <span className="truncate">{model}</span>
      ) : (
        <GlyphSpinner className="opacity-50" spinner="braille" />
      )}
      <ChevronDown className="size-2.5 shrink-0 opacity-50" />
    </>
  )

  const pillClass = compact
    ? cn(
        'size-(--composer-control-size) shrink-0 justify-center gap-0 rounded-md p-0',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      )
    : PILL

  const title = provider ? copy.modelTitle(provider, model || copy.modelNone) : copy.switchModel

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <Tip label={title} side="top">
        <DropdownMenuTrigger asChild>
          <Button aria-label={title} className={pillClass} disabled={disabled} type="button" variant="ghost">
            {label}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto" side="top" sideOffset={8}>
        {options === null ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-(--ui-text-tertiary)">
            <GlyphSpinner spinner="braille" />
            <span>{copy.openModelPicker}</span>
          </div>
        ) : options.length === 0 ? (
          <div className="px-2 py-2 text-xs text-(--ui-text-tertiary)">{copy.modelNone}</div>
        ) : (
          options.map(option => {
            const active = option.model === model && option.provider === provider
            return (
              <DropdownMenuItem
                className="gap-2 text-xs"
                key={`${option.provider}:${option.model}`}
                onSelect={() => void pick(option)}
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {active && <Check className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{option.model}</span>
                <span className="shrink-0 text-(--ui-text-tertiary)">{option.providerLabel}</span>
              </DropdownMenuItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
