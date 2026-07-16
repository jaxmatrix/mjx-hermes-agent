import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type NodeApi, type NodeRendererProps, type RowRendererProps, Tree, type TreeApi } from 'react-arborist'

import { Codicon } from '@/components/ui/codicon'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { $revealInTreeRequest } from '@/store/layout'

import { FileContextMenu } from './file-context-menu'
import type { TreeNode } from './use-project-tree'

// Ported from desktop's files/tree.tsx. react-arborist tree with lazy children +
// reveal-in-tree. Adaptations: no inline-rename / no drag-and-drop (deferred), an
// inlined ResizeObserver (no shared hook), and git tint driven by a passed map
// (universal has no `coding-status` store).

export type RepoChangeKind = 'added' | 'conflicted' | 'modified'

const ROW_HEIGHT = 22
const INDENT = 10
/** Fixed base inset layered on top of arborist's depth indent. */
const TREE_ROW_INSET = '13px'

function withTreeInset(paddingLeft: number | string | undefined): string {
  if (typeof paddingLeft === 'number') return `calc(${paddingLeft}px + ${TREE_ROW_INSET})`
  if (!paddingLeft) return TREE_ROW_INSET
  return `calc(${paddingLeft} + ${TREE_ROW_INSET})`
}

const CHANGE_TINT: Record<RepoChangeKind, string> = {
  added: 'text-(--ui-green)',
  conflicted: 'text-(--ui-red)',
  modified: 'text-(--ui-yellow)'
}

interface ProjectTreeProps {
  changeByPath?: Map<string, RepoChangeKind>
  collapseNonce: number
  cwd: string
  data: TreeNode[]
  onLoadChildren: (id: string) => void | Promise<void>
  onNodeOpenChange: (id: string, open: boolean) => void
  onPreviewFile: (path: string) => void
  openState: Record<string, boolean>
}

export function ProjectTree({
  changeByPath,
  collapseNonce,
  cwd,
  data,
  onLoadChildren,
  onNodeOpenChange,
  onPreviewFile,
  openState
}: ProjectTreeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const treeRef = useRef<TreeApi<TreeNode> | null>(null)
  const [size, setSize] = useState({ height: 0, width: 0 })

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const sync = () => {
      const { height, width } = el.getBoundingClientRect()
      setSize(prev => (prev.height === height && prev.width === width ? prev : { height, width }))
    }

    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleToggle = useCallback(
    (id: string) => {
      const node = treeRef.current?.get(id)
      if (!node) return

      onNodeOpenChange(id, node.isOpen)
      if (node.isOpen && node.data?.isDirectory && node.data.children === undefined) {
        void onLoadChildren(id)
      }
    },
    [onLoadChildren, onNodeOpenChange]
  )

  // Reveal-in-tree: expand each ancestor top-down (lazy-loading first), then
  // select + scroll to the target.
  const revealNode = useCallback(
    async (absPath: string) => {
      const root = cwd.replace(/[\\/]+$/, '')
      const target = absPath.replace(/[\\/]+$/, '')
      const rel = target.startsWith(root) ? target.slice(root.length).replace(/^[\\/]+/, '') : ''
      const segments = rel.split(/[\\/]/).filter(Boolean)

      let acc = root
      for (let i = 0; i < segments.length - 1; i += 1) {
        acc = `${acc}/${segments[i]}`
        const node = treeRef.current?.get(acc)
        if (node?.data?.isDirectory && node.data.children === undefined) await onLoadChildren(acc)
        onNodeOpenChange(acc, true)
        treeRef.current?.open(acc)
        await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
      }

      treeRef.current?.select(target)
      treeRef.current?.scrollTo(target, 'start')
    },
    [cwd, onLoadChildren, onNodeOpenChange]
  )

  useEffect(
    () =>
      $revealInTreeRequest.subscribe(path => {
        if (!path) return
        $revealInTreeRequest.set(null)
        void revealNode(path)
      }),
    [revealNode]
  )

  const handleActivate = useCallback(
    (node: NodeApi<TreeNode>) => {
      if (node.data && !node.data.isDirectory && !node.data.placeholder) onPreviewFile(node.data.id)
    },
    [onPreviewFile]
  )

  return (
    <div className="min-h-0 flex-1 overflow-hidden" ref={containerRef}>
      {size.height > 0 && size.width > 0 ? (
        <Tree<TreeNode>
          childrenAccessor={node => (node?.isDirectory ? (node.children ?? []) : null)}
          data={data}
          disableDrag
          disableDrop
          disableEdit
          height={size.height}
          indent={INDENT}
          initialOpenState={openState}
          key={`${cwd}:${collapseNonce}`}
          onActivate={handleActivate}
          onToggle={handleToggle}
          openByDefault={false}
          padding={0}
          ref={treeRef}
          renderRow={ProjectTreeRowContainer}
          rowHeight={ROW_HEIGHT}
          width={size.width}
        >
          {props => (
            <ProjectTreeRow
              {...props}
              changeKind={props.node.data ? changeByPath?.get(props.node.data.id) : undefined}
              onPreviewFile={onPreviewFile}
              relativeTo={cwd}
            />
          )}
        </Tree>
      ) : (
        <div className="flex flex-col gap-1.5 p-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton className="h-3.5" key={i} style={{ width: `${60 + ((i * 13) % 35)}%` }} />
          ))}
        </div>
      )}
    </div>
  )
}

// arborist's default row hardcodes `min-width: max-content`; we don't scroll
// sideways, so pin the row to the viewport width so long names ellipsize.
function ProjectTreeRowContainer({ attrs, children, innerRef, node }: RowRendererProps<TreeNode>) {
  return (
    <div
      {...attrs}
      onClick={node.handleClick}
      onFocus={e => e.stopPropagation()}
      ref={innerRef}
      style={{ ...attrs.style, minWidth: 0, width: '100%' }}
    >
      {children}
    </div>
  )
}

function ProjectTreeRow({
  changeKind,
  node,
  onPreviewFile,
  relativeTo,
  style
}: NodeRendererProps<TreeNode> & {
  changeKind?: RepoChangeKind
  onPreviewFile: (path: string) => void
  relativeTo?: null | string
}) {
  if (!node.data) return <div style={style} />

  const isFolder = node.data.isDirectory
  const isPlaceholder = Boolean(node.data.placeholder)
  const isErrorPlaceholder = node.data.placeholder === 'error'

  const row = (
    <div
      aria-expanded={isFolder ? node.isOpen : undefined}
      aria-selected={node.isSelected}
      className={cn(
        'row-hover flex h-full select-none items-center gap-1 border border-transparent px-3 text-xs font-normal text-(--ui-text-secondary) hover:text-foreground',
        node.isSelected && 'bg-(--ui-row-active-background) text-foreground',
        isPlaceholder && 'pointer-events-none italic text-muted-foreground/70'
      )}
      onClick={event => {
        event.stopPropagation()
        if (isPlaceholder) return
        if (isFolder) node.toggle()
        else node.select()
      }}
      onDoubleClick={event => {
        event.stopPropagation()
        if (!isFolder && !isPlaceholder) onPreviewFile(node.data.id)
      }}
      style={{ ...style, paddingLeft: withTreeInset(style.paddingLeft) }}
      title={node.data.id}
    >
      <span aria-hidden className="flex w-3.5 items-center justify-center text-(--ui-text-tertiary)">
        {isPlaceholder && !isErrorPlaceholder ? (
          <Codicon className="animate-spin" name="loading" size="0.75rem" />
        ) : isErrorPlaceholder ? (
          <Codicon name="warning" size="0.75rem" />
        ) : isFolder ? (
          <Codicon name={node.isOpen ? 'folder-opened' : 'folder'} size="0.875rem" />
        ) : (
          <Codicon name="file" size="0.875rem" />
        )}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', changeKind && CHANGE_TINT[changeKind])}>{node.data.name}</span>
    </div>
  )

  if (isPlaceholder) return row

  return (
    <FileContextMenu path={node.data.id} relativeTo={relativeTo}>
      {row}
    </FileContextMenu>
  )
}
