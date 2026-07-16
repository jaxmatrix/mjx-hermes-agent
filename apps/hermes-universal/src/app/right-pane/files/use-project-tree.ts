import { useCallback, useEffect, useMemo } from 'react'

import { atom, useStore } from '@/store/atom'
import { $connection } from '@/store/connection'
import { $workspaceChangeTick } from '@/store/workspace-events'

import { clearProjectDirCache, readProjectDir } from './ipc'

// Ported from desktop's files/use-project-tree.ts. Lazy directory tree over the
// remote REST `readDir`. Divergences: this client is always remote, so desktop's
// local `sanitizeWorkspaceCwd` fallback-root path is dropped; everything else
// (feature-owned atom so chat rerenders can't reset the tree, lazy children,
// non-destructive live revalidation, self-heal retry) is preserved.

export interface TreeNode {
  /** Absolute filesystem path. Doubles as react-arborist node id. */
  id: string
  name: string
  /** Drives arborist's leaf-vs-expandable decision via childrenAccessor. */
  isDirectory: boolean
  /** `undefined` = directory, children not yet loaded. `[]` = loaded empty. */
  children?: TreeNode[]
  /** True while a readDir for this folder is in flight. */
  loading?: boolean
  /** Synthetic loading/error rows are not real filesystem entries. */
  placeholder?: 'error' | 'loading'
  /** Last error from readDir. Cleared on next successful load. */
  error?: string
}

const PLACEHOLDER_ID = '__loading__'
const ERROR_PLACEHOLDER_ID = '__error__'

function makeNode(path: string, name: string, isDirectory: boolean): TreeNode {
  return { id: path, isDirectory, name }
}

function patchNode(nodes: TreeNode[] | undefined | null, id: string, patch: (n: TreeNode) => TreeNode): TreeNode[] {
  if (!nodes) return []

  return nodes.map(n => {
    if (n.id === id) return patch(n)
    if (n.children && n.children.length > 0) return { ...n, children: patchNode(n.children, id, patch) }
    return n
  })
}

function placeholderChild(parentId: string): TreeNode {
  return { id: `${parentId}::${PLACEHOLDER_ID}`, isDirectory: false, name: 'Loading…', placeholder: 'loading' }
}

function errorChild(parentId: string, error: string | undefined): TreeNode {
  return {
    id: `${parentId}::${ERROR_PLACEHOLDER_ID}`,
    isDirectory: false,
    name: `Unable to read (${error || 'read-error'})`,
    placeholder: 'error'
  }
}

export interface UseProjectTreeResult {
  collapseNonce: number
  data: TreeNode[]
  effectiveCwd: string
  openState: Record<string, boolean>
  rootError: string | null
  rootLoading: boolean
  collapseAll: () => void
  loadChildren: (id: string) => Promise<void>
  refreshRoot: () => Promise<void>
  setNodeOpen: (id: string, open: boolean) => void
}

interface ProjectTreeState {
  collapseNonce: number
  cwd: string
  data: TreeNode[]
  loaded: boolean
  openState: Record<string, boolean>
  requestId: number
  resolvedCwd: string
  rootError: string | null
  rootLoading: boolean
}

const initialState: ProjectTreeState = {
  collapseNonce: 0,
  cwd: '',
  data: [],
  loaded: false,
  openState: {},
  requestId: 0,
  resolvedCwd: '',
  rootError: null,
  rootLoading: false
}

const inflight = new Set<string>()
const $projectTree = atom<ProjectTreeState>(initialState)
let nextRootRequestId = 0
let lastConnectionKey = ''

const ROOT_ERROR_RETRY_MS = 3_000

function setProjectTree(updater: (current: ProjectTreeState) => ProjectTreeState) {
  $projectTree.set(updater($projectTree.get()))
}

function clearProjectTree() {
  nextRootRequestId += 1
  inflight.clear()
  $projectTree.set({ ...initialState, requestId: nextRootRequestId })
}

async function loadRoot(cwd: string, { force = false }: { force?: boolean } = {}) {
  if (!cwd) {
    clearProjectTree()
    return
  }

  const current = $projectTree.get()
  if (!force && current.cwd === cwd && (current.loaded || current.rootLoading)) return

  const requestId = nextRootRequestId + 1
  nextRootRequestId = requestId
  inflight.clear()

  if (force || current.cwd !== cwd) clearProjectDirCache(cwd)

  $projectTree.set({
    collapseNonce: current.collapseNonce,
    cwd,
    data: [],
    loaded: false,
    openState: current.cwd === cwd ? current.openState : {},
    requestId,
    resolvedCwd: '',
    rootError: null,
    rootLoading: true
  })

  const { entries, error } = await readProjectDir(cwd)

  setProjectTree(latest => {
    if (latest.cwd !== cwd || latest.requestId !== requestId) return latest

    return {
      ...latest,
      data: error ? [] : entries.map(e => makeNode(e.path, e.name, e.isDirectory)),
      loaded: true,
      resolvedCwd: cwd,
      rootError: error || null,
      rootLoading: false
    }
  })
}

export function resetProjectTreeState() {
  lastConnectionKey = ''
  clearProjectTree()
  clearProjectDirCache()
}

// Non-destructive refresh: re-read every loaded directory and merge entries
// (add new, drop deleted) while preserving expansion + loaded subtrees.
async function revalidateTree(cwd: string): Promise<void> {
  const state = $projectTree.get()
  if (!cwd || state.cwd !== cwd || !state.loaded) return

  const rootPath = state.resolvedCwd || cwd
  clearProjectDirCache()

  const reconcile = async (dirPath: string, existing: TreeNode[]): Promise<TreeNode[]> => {
    const { entries, error } = await readProjectDir(dirPath)
    if (error) return existing

    const byId = new Map(existing.filter(node => !node.placeholder).map(node => [node.id, node]))
    const merged: TreeNode[] = []

    for (const entry of entries) {
      const prev = byId.get(entry.path)
      if (prev?.isDirectory && prev.children) {
        merged.push({ ...prev, children: await reconcile(prev.id, prev.children) })
      } else if (prev) {
        merged.push(prev)
      } else {
        merged.push(makeNode(entry.path, entry.name, entry.isDirectory))
      }
    }

    return merged
  }

  const nextData = await reconcile(rootPath, state.data)
  setProjectTree(latest => (latest.cwd === cwd && latest.loaded ? { ...latest, data: nextData } : latest))
}

/**
 * Lazy-loads a directory tree rooted at `cwd`. Children fetch on first expand and
 * cache in this feature-owned atom so unrelated rerenders can't reset the browser.
 */
export function useProjectTree(cwd: string): UseProjectTreeResult {
  const state = useStore($projectTree)
  const connection = useStore($connection)
  const workspaceTick = useStore($workspaceChangeTick)
  const connectionKey = `${connection?.mode || 'remote'}:${connection?.profile || ''}:${connection?.baseUrl || ''}`

  const refreshRoot = useCallback(() => loadRoot(cwd, { force: true }), [cwd])

  const setNodeOpen = useCallback(
    (id: string, open: boolean) => {
      setProjectTree(current => {
        if (current.cwd !== cwd || current.openState[id] === open) return current
        return { ...current, openState: { ...current.openState, [id]: open } }
      })
    },
    [cwd]
  )

  const collapseAll = useCallback(() => {
    setProjectTree(current => {
      if (current.cwd !== cwd) return current
      return { ...current, collapseNonce: current.collapseNonce + 1, openState: {} }
    })
  }, [cwd])

  const loadChildren = useCallback(
    async (id: string) => {
      if (!cwd || inflight.has(id)) return

      inflight.add(id)

      setProjectTree(current => {
        if (current.cwd !== cwd) return current
        return {
          ...current,
          data: patchNode(current.data, id, n => ({ ...n, loading: true, children: [placeholderChild(n.id)] }))
        }
      })

      const { entries, error } = await readProjectDir(id)

      inflight.delete(id)

      setProjectTree(current => {
        if (current.cwd !== cwd) return current
        return {
          ...current,
          data: patchNode(current.data, id, n => ({
            ...n,
            loading: false,
            error: error || undefined,
            children: error ? [errorChild(n.id, error)] : entries.map(e => makeNode(e.path, e.name, e.isDirectory))
          }))
        }
      })
    },
    [cwd]
  )

  // Live, non-destructive refresh when the workspace changes (skip tick 0).
  useEffect(() => {
    if (workspaceTick > 0) void revalidateTree(cwd)
  }, [workspaceTick, cwd])

  useEffect(() => {
    const connectionChanged = lastConnectionKey !== '' && lastConnectionKey !== connectionKey
    lastConnectionKey = connectionKey

    if (connectionChanged) {
      clearProjectDirCache()
      void loadRoot(cwd, { force: true })
      return
    }

    void loadRoot(cwd)
  }, [connectionKey, cwd])

  // Self-heal: an errored root re-probes every few seconds while mounted.
  useEffect(() => {
    if (!cwd || state.cwd !== cwd || !state.rootError) return
    const timer = window.setTimeout(() => void loadRoot(cwd, { force: true }), ROOT_ERROR_RETRY_MS)
    return () => window.clearTimeout(timer)
  }, [cwd, state.cwd, state.requestId, state.rootError])

  return useMemo(
    () => ({
      collapseAll,
      collapseNonce: state.cwd === cwd ? state.collapseNonce : 0,
      data: state.cwd === cwd ? state.data : [],
      effectiveCwd: state.cwd === cwd && state.resolvedCwd ? state.resolvedCwd : cwd,
      loadChildren,
      openState: state.cwd === cwd ? state.openState : {},
      refreshRoot,
      rootError: state.cwd === cwd ? state.rootError : null,
      rootLoading: state.cwd === cwd ? state.rootLoading : Boolean(cwd),
      setNodeOpen
    }),
    [
      collapseAll,
      cwd,
      loadChildren,
      refreshRoot,
      setNodeOpen,
      state.collapseNonce,
      state.cwd,
      state.data,
      state.openState,
      state.resolvedCwd,
      state.rootError,
      state.rootLoading
    ]
  )
}
