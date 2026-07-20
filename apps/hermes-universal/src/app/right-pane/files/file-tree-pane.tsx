import { type ReactNode, useEffect, useState } from 'react'

import { SidebarPanelLabel } from '@/app/shell/sidebar-label'
import { Codicon } from '@/components/ui/codicon'
import { getGitRoot, getRepoStatus } from '@/hermes'
import { useI18n } from '@/i18n'
import { IS_DESKTOP } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $effectiveCwd, $workspaceChangeTick, ensureWorkspaceCwd } from '@/store/workspace-events'

import { ProjectTree, type RepoChangeKind } from './tree'
import { useProjectTree } from './use-project-tree'

// Right-pane file tree. Adapted from desktop's right-sidebar/index.tsx: workspace
// header (refresh / collapse-all) + the react-arborist tree + empty/error states,
// wired to the remote workspace cwd + git status.

function useRepoChanges(cwd: string, tick: number): Map<string, RepoChangeKind> {
  const [map, setMap] = useState<Map<string, RepoChangeKind>>(() => new Map())

  useEffect(() => {
    if (!cwd) {
      setMap(new Map())
      return
    }

    let cancelled = false
    void Promise.all([getGitRoot(cwd), getRepoStatus(cwd)])
      .then(([{ root }, status]) => {
        if (cancelled || !status || !root) return
        const base = root.replace(/[\\/]+$/, '')
        const next = new Map<string, RepoChangeKind>()
        for (const file of status.files) {
          const abs = `${base}/${file.path}`
          next.set(abs, file.conflicted ? 'conflicted' : file.untracked ? 'added' : 'modified')
        }
        setMap(next)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [cwd, tick])

  return map
}

function HeaderButton({ children, onClick, title }: { children: ReactNode; onClick: () => void; title: string }) {
  return (
    <button
      aria-label={title}
      className="inline-flex size-6 items-center justify-center rounded text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground"
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  )
}

function CenteredState({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

export function FileTreePane({ onPreviewFile }: { onPreviewFile: (path: string) => void }) {
  const { t } = useI18n()
  const r = t.rightSidebar
  // Roots at the active chat's project directory (falling back to the workspace
  // root), so switching chats re-roots the tree with them.
  const cwd = useStore($effectiveCwd)
  const tick = useStore($workspaceChangeTick)

  useEffect(() => {
    void ensureWorkspaceCwd()
  }, [])

  const tree = useProjectTree(cwd)
  const changeByPath = useRepoChanges(tree.effectiveCwd || cwd, tick)
  // The workspace folder name (cwd leaf), shown uppercase like the desktop
  // filesystem/cron section headers.
  const cwdName = (tree.effectiveCwd || cwd).split(/[\\/]+/).filter(Boolean).pop() ?? ''

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col bg-(--ui-sidebar-surface-background)',
        // Clear the transparent titlebar overlay (siblings of PaneMain don't inherit its padding).
        IS_DESKTOP && 'pt-(--titlebar-height)'
      )}
    >
      <header className="flex h-8 shrink-0 items-center justify-between gap-1 px-2">
        <div className="flex min-w-0 flex-1">{cwdName && <SidebarPanelLabel>{cwdName}</SidebarPanelLabel>}</div>
        <div className="flex items-center gap-0.5">
          <HeaderButton onClick={() => void tree.refreshRoot()} title={r.refreshTree}>
            <Codicon name="refresh" size="0.8rem" />
          </HeaderButton>
          <HeaderButton onClick={tree.collapseAll} title={r.collapseAll}>
            <Codicon name="collapse-all" size="0.8rem" />
          </HeaderButton>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {!cwd ? (
          <CenteredState>
            <p className="font-medium text-foreground">{r.noProjectTitle}</p>
            <p>{r.noProjectBody}</p>
          </CenteredState>
        ) : tree.rootError ? (
          <CenteredState>
            <p className="font-medium text-foreground">{r.treeErrorTitle}</p>
            <p>{r.treeErrorBody}</p>
            <button
              className="mt-1 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-(--ui-control-hover-background)"
              onClick={() => void tree.refreshRoot()}
              type="button"
            >
              {r.tryAgain}
            </button>
          </CenteredState>
        ) : (
          <ProjectTree
            changeByPath={changeByPath}
            collapseNonce={tree.collapseNonce}
            cwd={tree.effectiveCwd}
            data={tree.data}
            onLoadChildren={tree.loadChildren}
            onNodeOpenChange={tree.setNodeOpen}
            onPreviewFile={onPreviewFile}
            openState={tree.openState}
          />
        )}
      </div>
    </div>
  )
}
