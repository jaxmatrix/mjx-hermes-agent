/**
 * The state of the tunnels behind this window's local and SSH sources, in
 * words: what the Gateways page lists and the status bar summarises.
 *
 * A URL or cloud source has no tunnel and never appears. Copy only — a tunnel's
 * own message can name its host (`store/connection-tunnels`).
 */

import { sshStepLabel, tunnelErrorMessage } from '@/app/gateway/ssh-copy'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $tunnelStatus, type TunnelStatus } from '@/store/connection-tunnels'
import { $registryView } from '@/store/connections'

import { CONNECTIONS_PAGE_PATH } from './paths'

export interface TunnelLine {
  connectionId: string
  label: string
  phase: TunnelStatus['phase']
  text: string
}

export function useTunnelLines(): TunnelLine[] {
  const { t } = useI18n()
  const registry = useStore($registryView)
  const tunnels = useStore($tunnelStatus)
  const g = t.settings.gateway

  return registry.connections.flatMap(row => {
    const status = tunnels[row.id]

    // A slot that left has nothing to say; whatever ended it was said then.
    if (!status || status.phase === 'closed' || (row.kind !== 'local' && row.kind !== 'ssh')) {
      return []
    }

    const text =
      status.phase === 'ready'
        ? g.cloudConnectedPill
        : status.phase === 'failed'
          ? tunnelErrorMessage({ kind: status.errorKind }, g)
          : status.step
            ? sshStepLabel(status.step, g)
            : status.phase === 'retrying'
              ? t.boot.steps.retryingRemoteBackend
              : t.boot.steps.startingDesktopConnection

    return [{ connectionId: row.id, label: row.label, phase: status.phase, text }]
  })
}

const TONE: Record<TunnelLine['phase'], string> = {
  closed: 'text-muted-foreground',
  connecting: 'text-muted-foreground',
  failed: 'text-destructive',
  ready: 'text-emerald-500',
  retrying: 'text-amber-500'
}

/** The page's list: one line per tunnelled source that has a tunnel. */
export function TunnelStatusList() {
  const lines = useTunnelLines()

  if (lines.length === 0) {
    return null
  }

  return (
    <ul className="mb-3 flex flex-col gap-1" data-testid="tunnel-status">
      {lines.map(line => (
        <li className="flex min-w-0 items-center gap-2 text-sm" key={line.connectionId}>
          <Codicon className={cn('shrink-0', TONE[line.phase])} name="circle-filled" size="0.6rem" />
          <span className="min-w-0 truncate font-medium">{line.label}</span>
          <span className="min-w-0 truncate text-muted-foreground">{line.text}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The status bar's way in: present only while a tunnel needs a person or is
 * still coming up — a healthy one is not news, and with none there is no item.
 */
export function TunnelStatusChip() {
  const lines = useTunnelLines().filter(line => line.phase !== 'ready')
  const first = lines[0]

  if (!first) {
    return null
  }

  return (
    <Tip label={`${first.label} — ${first.text}`}>
      <button
        className={cn(
          'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] transition-colors',
          'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
        )}
        onClick={() => {
          window.location.hash = `#${CONNECTIONS_PAGE_PATH}`
        }}
        type="button"
      >
        <Codicon className={TONE[first.phase]} name="remote" size="0.7rem" />
        <span className="max-w-40 truncate">{first.label}</span>
      </button>
    </Tip>
  )
}
