import { useEffect, useMemo, useState } from 'react'

import { SidebarTrigger } from '@/app/shell/sidebar'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { deleteLearningNode, getLearningNode } from '@/hermes'
import { useI18n } from '@/i18n'
import { Refresh } from '@/lib/icons'
import { useStore } from '@/store/atom'
import { notify, notifyError } from '@/store/notifications'
import { $starmapError, $starmapGraph, $starmapLoading, evictStarmapNode, loadStarmapGraph } from '@/store/starmap'
import type { StarmapNode } from '@/types/hermes'

import { filterGraph, type StarmapFilter } from './graph-sim'
import { StarmapCanvas } from './starmap-canvas'

export function StarmapScreen() {
  const { t } = useI18n()
  const sm = t.starmap
  const graph = useStore($starmapGraph)
  const loading = useStore($starmapLoading)
  const error = useStore($starmapError)
  const [filter, setFilter] = useState<StarmapFilter>('all')
  const [selected, setSelected] = useState<StarmapNode | null>(null)

  useEffect(() => void loadStarmapGraph(), [])

  const view = useMemo(() => (graph ? filterGraph(graph, filter) : { nodes: [], edges: [] }), [graph, filter])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-foreground">{sm.title}</h1>
          {graph && (
            <p className="truncate text-xs text-muted-foreground">{sm.subtitle(graph.nodes.length, graph.clusters.length)}</p>
          )}
        </div>
        <Button aria-label={sm.refresh} onClick={() => void loadStarmapGraph(true)} size="icon-sm" variant="ghost">
          <Refresh className="size-5" />
        </Button>
      </header>

      <div className="border-b border-border px-3 py-2">
        <Tabs onValueChange={v => setFilter(v as StarmapFilter)} value={filter}>
          <TabsList className="w-full">
            <TabsTrigger className="flex-1" value="all">
              {sm.filterAll}
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="used">
              {sm.filterUsed}
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="learned">
              {sm.filterLearned}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {loading && !graph ? (
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">{sm.loading}</div>
      ) : error && !graph ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <span className="text-sm text-muted-foreground">{sm.loadFailed}</span>
          <Button onClick={() => void loadStarmapGraph(true)} size="sm">
            {t.common.retry}
          </Button>
        </div>
      ) : view.nodes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
          <span className="text-sm font-medium text-foreground">{sm.emptyTitle}</span>
          <span className="text-xs text-muted-foreground">{sm.emptyDesc}</span>
        </div>
      ) : (
        <StarmapCanvas edges={view.edges} nodes={view.nodes} onSelect={setSelected} />
      )}

      <NodeSheet
        node={selected}
        onDeleted={id => {
          evictStarmapNode(id)
          setSelected(null)
        }}
        onOpenChange={open => !open && setSelected(null)}
      />
    </div>
  )
}

function NodeSheet({ node, onDeleted, onOpenChange }: { node: StarmapNode | null; onDeleted: (id: string) => void; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n()
  const sm = t.starmap
  const [content, setContent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canDelete = Boolean(node && (node.kind === 'memory' || node.createdBy))

  useEffect(() => {
    if (!node) {
      return
    }
    setContent(null)
    let cancelled = false
    void getLearningNode(node.id)
      .then(d => !cancelled && setContent(d.content))
      .catch(() => !cancelled && setContent(''))
    return () => void (cancelled = true)
  }, [node])

  const remove = async () => {
    if (!node) {
      return
    }
    setBusy(true)
    try {
      await deleteLearningNode(node.id)
      notify({ kind: 'success', message: t.common.done })
      onDeleted(node.id)
    } catch (err) {
      notifyError(err, t.common.failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={node !== null}>
      <SheetContent className="max-h-[min(42rem,88vh)] gap-3 overflow-y-auto rounded-t-xl p-4" side="bottom">
        <SheetHeader className="p-0">
          <SheetTitle>{node?.label}</SheetTitle>
          <SheetDescription>
            {node?.category}
            {node && node.useCount > 0 ? ` · ${node.useCount}×` : ''}
            {node?.pinned ? ' · ★' : ''}
          </SheetDescription>
        </SheetHeader>

        {content === null ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{sm.loading}</p>
        ) : content ? (
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {content}
          </pre>
        ) : null}

        {canDelete && (
          <Button className="w-full" disabled={busy} onClick={() => void remove()} variant="destructive">
            {t.common.delete}
          </Button>
        )}
      </SheetContent>
    </Sheet>
  )
}
