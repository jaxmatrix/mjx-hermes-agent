import { useEffect, useState } from 'react'

import { GatewayConfigurator } from '@/app/gateway/gateway-configurator'
import { MasterDetail } from '@/app/master-detail'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
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
import { $latchedConnections, releaseLatch } from '@/store/connection-latches'
import { hasMultipleUpdateTargets, updateAllTargets } from '@/store/connection-updates'
import { $connectionsRegistry, refreshConnections, setLaunchMode } from '@/store/connections'
import { notify, notifyError } from '@/store/notifications'

import { SettingsContent } from '../primitives'

import { type ConnectionDraft, ConnectionEditor } from './connection-editor'

/**
 * SETTINGS ▸ GATEWAYS.
 *
 * The nav id stays `gateway` so every existing deep link, ⌘K row, plugin
 * contribution and `settingRowElementId` keeps resolving — only the label
 * changed.
 *
 * WITH ONE SOURCE THIS PAGE IS EXACTLY TODAY'S: the gateway configurator and
 * nothing else. That is acceptance criterion 1, and it is why the list, the
 * launch-mode radio and "Update everything" all hang off having more than one
 * row (or an open draft). The palette's "Add a gateway…" is what opens the draft
 * on a single-source install.
 *
 * `●` is the connection THIS window is on; `★` is the registry primary. They are
 * different things and the page says so.
 */
export function ConnectionsSection() {
  const { t } = useI18n()
  const c = t.settings.connections
  const registry = useStore($connectionsRegistry)
  const active = useStore($activeConnection)
  const latched = useStore($latchedConnections)
  const [selected, setSelected] = useState<null | string>(null)
  const [draft, setDraft] = useState<ConnectionDraft | null>(null)
  const [term, setTerm] = useState('')
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    void refreshConnections().catch(() => {})
  }, [])

  const rows = sortConnectionsForDisplay(registry.connections)
  const showRegistry = rows.length > 1 || draft !== null

  if (!showRegistry) {
    // Exactly today's page: the shared configurator in the settings scroll
    // container. This replaced `gateway-section.tsx`, which held nothing else.
    return (
      <SettingsContent>
        <GatewayConfigurator variant="settings" />
      </SettingsContent>
    )
  }

  const searchable = rows.length >= CONNECTION_SEARCH_THRESHOLD
  const visible = searchable ? rows.filter(row => connectionSearchMatches(row, term)) : rows
  const current = registry.connections.find(row => row.id === selected)

  const runUpdateAll = async () => {
    setUpdating(true)

    try {
      const results = await updateAllTargets()
      const failed = results.filter(row => !row.ok && !row.skipped)

      notify({
        kind: failed.length > 0 ? 'warning' : 'success',
        message: c.updateAllSummary(results.length, failed.length),
        title: c.updateAll
      })
    } catch (error) {
      notifyError(error, c.updateAll)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <SettingsContent>
      {registry.degraded && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">{c.degradedTitle}</p>
          <p className="text-xs text-muted-foreground">{c.degradedReason(registry.degraded)}</p>
        </div>
      )}

      {registry.readOnly && <p className="mb-3 text-sm text-muted-foreground">{c.readOnly}</p>}

      <MasterDetail
        pane={
          <div className="flex min-w-0 flex-col gap-1 p-2">
            {searchable && (
              <input
                aria-label={c.searchPlaceholder}
                className="mb-1 w-full rounded-sm bg-muted px-2 py-1.5 text-sm outline-none"
                onChange={event => setTerm(event.target.value)}
                placeholder={c.searchPlaceholder}
                value={term}
              />
            )}

            {visible.map(row => (
              <button
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm hover:bg-accent',
                  row.id === selected && 'bg-accent'
                )}
                key={row.id}
                onClick={() => {
                  setDraft(null)
                  setSelected(row.id)
                }}
                type="button"
              >
                <Codicon
                  className={cn('shrink-0', row.id === active?.connectionId ? 'text-foreground' : 'text-transparent')}
                  name="circle-filled"
                  size="0.7rem"
                />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {row.id === registry.primary && (
                  <Codicon className="shrink-0 text-muted-foreground" name="star-full" size="0.8rem" />
                )}
                {latched[row.id] && (
                  <Tip label={c.latchedMessage(latched[row.id] ?? '')}>
                    <button
                      aria-label={c.latchedMessage(latched[row.id] ?? '')}
                      className="shrink-0 text-amber-500"
                      onClick={event => {
                        event.stopPropagation()
                        releaseLatch(row.id)
                      }}
                      type="button"
                    >
                      <Codicon name="warning" size="0.85rem" />
                    </button>
                  </Tip>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">{row.kind}</span>
              </button>
            ))}

            {visible.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">{c.searchEmpty(term)}</p>}

            <Button
              className="mt-1 justify-start"
              disabled={registry.readOnly}
              onClick={() => {
                setSelected(null)
                setDraft({ kind: 'remote' })
              }}
              size="sm"
              variant="ghost"
            >
              <Codicon name="add" size="0.9rem" />
              {c.add}
            </Button>
          </div>
        }
        resizeId="connections"
      >
        {current || draft ? (
          <ConnectionEditor
            connection={current}
            draft={draft ?? undefined}
            key={current?.id ?? 'draft'}
            onSaved={id => {
              setDraft(null)
              setSelected(id)
            }}
            registry={registry}
          />
        ) : (
          <div className="p-4 text-sm text-muted-foreground">{c.pickOne}</div>
        )}
      </MasterDetail>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="text-sm">{c.launchMode}</span>
        {(['primary', 'last-used'] as const).map(mode => (
          <label className="flex items-center gap-1.5 text-sm" key={mode}>
            <input
              checked={registry.launchMode === mode}
              disabled={registry.readOnly}
              name="connections-launch-mode"
              onChange={() => void setLaunchMode(mode).catch(error => notifyError(error, c.saveFailed))}
              type="radio"
            />
            {mode === 'primary' ? c.launchPrimary : c.launchLastUsed}
          </label>
        ))}

        {hasMultipleUpdateTargets() && (
          <Button className="ms-auto" disabled={updating} onClick={() => void runUpdateAll()} size="sm" variant="secondary">
            {c.updateAll}
          </Button>
        )}
      </div>

      {current && connectionEndpointLabel(current) && (
        <p className="sr-only">{connectionEndpointLabel(current)}</p>
      )}
    </SettingsContent>
  )
}
