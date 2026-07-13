import { EmptyState, Pill, SettingsContent } from '@/app/settings/primitives'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { allSubagents, buildSubagentTree, type SubagentNode, $subagentsBySession } from '@/store/subagents'

const STATUS_TONE: Record<string, string> = {
  running: 'text-primary',
  queued: 'text-muted-foreground',
  completed: 'text-[var(--ui-good)]',
  failed: 'text-destructive',
  interrupted: 'text-destructive'
}

function SubagentCard({ node, depth }: { node: SubagentNode; depth: number }) {
  const { t } = useI18n()
  const a = t.agents
  const lastLine = node.stream.at(-1)
  const statusLabel =
    node.status === 'running' || node.status === 'queued'
      ? a.running
      : node.status === 'failed' || node.status === 'interrupted'
        ? a.failed
        : a.done

  return (
    <div className="mt-2" style={{ marginLeft: `${depth * 0.75}rem` }}>
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{node.goal}</span>
          <span className={cn('shrink-0 text-xs font-medium', STATUS_TONE[node.status])}>{statusLabel}</span>
        </div>
        {node.currentTool && <div className="mt-1 font-mono text-xs text-muted-foreground">{node.currentTool}</div>}
        {lastLine && <div className="mt-1 truncate text-xs text-muted-foreground">{lastLine.text}</div>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {node.model && <Pill>{node.model}</Pill>}
          {node.toolCount ? <Pill>{a.toolsCount(node.toolCount)}</Pill> : null}
          {node.filesRead.length + node.filesWritten.length > 0 && (
            <Pill>{a.filesCount(node.filesRead.length + node.filesWritten.length)}</Pill>
          )}
          {node.outputTokens ? <Pill>{a.tokens(String(node.outputTokens))}</Pill> : null}
          {node.durationSeconds ? <Pill>{a.durationSeconds(String(Math.round(node.durationSeconds)))}</Pill> : null}
        </div>
      </div>
      {node.children.map(child => (
        <SubagentCard depth={depth + 1} key={child.id} node={child} />
      ))}
    </div>
  )
}

export function AgentsScreen() {
  const { t } = useI18n()
  const a = t.agents
  const bySession = useStore($subagentsBySession)
  const tree = buildSubagentTree(allSubagents(bySession))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-foreground">{a.title}</h1>
          <p className="truncate text-xs text-muted-foreground">{a.subtitle}</p>
        </div>
      </header>

      {tree.length === 0 ? (
        <SettingsContent>
          <EmptyState description={a.emptyDesc} title={a.emptyTitle} />
        </SettingsContent>
      ) : (
        <SettingsContent>
          <div className="pt-1 pb-4">
            {tree.map(node => (
              <SubagentCard depth={0} key={node.id} node={node} />
            ))}
          </div>
        </SettingsContent>
      )}
    </div>
  )
}
