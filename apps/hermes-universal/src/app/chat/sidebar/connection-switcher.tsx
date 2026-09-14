import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import {
  CONNECTION_SEARCH_THRESHOLD,
  connectionEndpointLabel,
  connectionSearchMatches,
  sortConnectionsForDisplay
} from '@/lib/connection-display'
import { cn } from '@/lib/utils'
import { $activeConnection } from '@/store/active-connection'
import { useStore } from '@/store/atom'
import { $latchedConnections } from '@/store/connection-latches'
import { $connectionsRegistry, $hasMultipleConnections, selectConnection } from '@/store/connections'

/**
 * WHICH MACHINE — one row above the profile rail.
 *
 * A NAMED selector, not profile-like glyphs. A source is a machine and a profile
 * is a persona; giving them the same visual language is exactly the confusion
 * desktop spent four commits undoing. So this is a labelled button with a
 * chevron, and the rail below it is untouched.
 *
 * WITH ONE SOURCE THE WHOLE ROW IS ABSENT — not disabled, not collapsed. A
 * single-source install keeps today's exact sidebar and keyboard flow, which is
 * acceptance criterion 1.
 */
export function ConnectionSwitcher() {
  const { t } = useI18n()
  const registry = useStore($connectionsRegistry)
  const active = useStore($activeConnection)
  const latched = useStore($latchedConnections)
  const multiple = useStore($hasMultipleConnections)
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [pending, setPending] = useState<null | string>(null)

  if (!multiple) {
    return null
  }

  const sorted = sortConnectionsForDisplay(registry.connections)
  const searchable = sorted.length >= CONNECTION_SEARCH_THRESHOLD
  const rows = searchable ? sorted.filter(row => connectionSearchMatches(row, term)) : sorted
  const label = active?.label ?? t.settings.connections.noSource

  const choose = async (id: string) => {
    if (id === active?.connectionId) {
      setOpen(false)

      return
    }

    // The control stays STABLE while a remote opens: a switch can take 90 s over
    // ssh, and a button that jumps or empties mid-dial reads as a failure.
    setPending(id)

    try {
      await selectConnection(id)
    } finally {
      setPending(null)
      setOpen(false)
    }
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button className="w-full justify-start gap-2 px-2" size="sm" variant="ghost">
          <Codicon className="shrink-0 text-muted-foreground" name="server" size="1rem" />
          <span className="min-w-0 flex-1 truncate text-start">{pending ? t.settings.connections.connecting(registry.connections.find(row => row.id === pending)?.label ?? '') : label}</span>
          <Codicon className="shrink-0 text-muted-foreground" name="chevron-down" size="0.9rem" />
        </Button>
      </PopoverTrigger>

      {/* Anchored to the keyboard inset (rule 32) even though the desktop layout
          never needs it — the same component is what any mobile shell mounts. */}
      <PopoverContent
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] p-1"
        style={{ maxHeight: 'calc(60vh - var(--keyboard-inset, 0px))' }}
      >
        {searchable && (
          <input
            aria-label={t.settings.connections.searchPlaceholder}
            className="mb-1 w-full rounded-sm bg-muted px-2 py-1.5 text-sm outline-none"
            onChange={event => setTerm(event.target.value)}
            placeholder={t.settings.connections.searchPlaceholder}
            value={term}
          />
        )}

        <div className="max-h-[inherit] overflow-y-auto">
          {rows.map(row => {
            const endpoint = connectionEndpointLabel(row)
            const isActive = row.id === active?.connectionId

            return (
              <button
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm hover:bg-accent',
                  isActive && 'bg-accent/60'
                )}
                key={row.id}
                onClick={() => void choose(row.id)}
                type="button"
              >
                <Codicon
                  className={cn('shrink-0', isActive ? 'text-foreground' : 'text-transparent')}
                  name="check"
                  size="0.9rem"
                />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {latched[row.id] && (
                  <Codicon className="shrink-0 text-amber-500" name="warning" size="0.9rem" />
                )}
                {endpoint && <span className="shrink-0 truncate text-xs text-muted-foreground">{endpoint}</span>}
              </button>
            )
          })}

          {rows.length === 0 && (
            // An empty large-list search explains itself rather than showing a
            // blank popover.
            <p className="px-2 py-3 text-sm text-muted-foreground">{t.settings.connections.searchEmpty(term)}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
