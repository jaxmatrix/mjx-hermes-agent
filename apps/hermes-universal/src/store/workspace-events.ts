import { getDefaultCwd } from '@/hermes'
import { atom } from '@/store/atom'

// Ported from desktop's store/workspace-events.ts. Bumped whenever the workspace
// filesystem may have changed (a settled agent turn, an in-app file save) so the
// file tree can live-refresh non-destructively.
export const $workspaceChangeTick = atom(0)

export function notifyWorkspaceChanged(): void {
  $workspaceChangeTick.set($workspaceChangeTick.get() + 1)
}

// The backend workspace root (from `/api/fs/default-cwd`) — the tree root, the
// terminal's initial cwd, and the git-status/diff base. Loaded once on first use;
// refreshed on reconnect via `resetWorkspaceCwd`.
export const $workspaceCwd = atom<string>('')
export const $workspaceBranch = atom<string>('')
let cwdInflight: Promise<string> | null = null

export function ensureWorkspaceCwd(): Promise<string> {
  const existing = $workspaceCwd.get()
  if (existing) return Promise.resolve(existing)
  if (cwdInflight) return cwdInflight

  cwdInflight = getDefaultCwd()
    .then(({ branch, cwd }) => {
      $workspaceCwd.set(cwd)
      $workspaceBranch.set(branch)
      return cwd
    })
    .catch(() => '')
    .finally(() => {
      cwdInflight = null
    })

  return cwdInflight
}

export function resetWorkspaceCwd(): void {
  $workspaceCwd.set('')
  $workspaceBranch.set('')
  cwdInflight = null
}
