/**
 * `hermesDesktop.git` — local git over Rust.
 *
 * Scan → `repo_scan_git_repos`. Worktrees/branches → `git_worktree_*` /
 * `git_branch_*`. Status/review → `git_repo_status` / `git_review_*`
 * (Electron `git-review-ops.ts`).
 */

type Bridge = NonNullable<typeof window.hermesDesktop>
type GitBridge = NonNullable<Bridge['git']>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const scanRepos: GitBridge['scanRepos'] = async (roots, options = {}) => {
  try {
    return await invokeNative('repo_scan_git_repos', {
      roots: Array.isArray(roots) ? roots : [],
      maxDepth: options.maxDepth ?? null,
      enabled: options.enabled ?? null,
      excludePaths: options.excludePaths ?? null
    })
  } catch {
    return []
  }
}

const worktreeList: GitBridge['worktreeList'] = async repoPath =>
  invokeNative('git_worktree_list', { repoPath: String(repoPath ?? '') })

const worktreeAdd: GitBridge['worktreeAdd'] = async (repoPath, options) =>
  invokeNative('git_worktree_add', { repoPath: String(repoPath ?? ''), options: options ?? null })

const worktreeRemove: GitBridge['worktreeRemove'] = async (repoPath, worktreePath, options) =>
  invokeNative('git_worktree_remove', {
    repoPath: String(repoPath ?? ''),
    worktreePath: String(worktreePath ?? ''),
    options: options ?? null
  })

const branchSwitch: GitBridge['branchSwitch'] = async (repoPath, branch) =>
  invokeNative('git_branch_switch', {
    repoPath: String(repoPath ?? ''),
    branch: String(branch ?? '')
  })

const branchList: GitBridge['branchList'] = async repoPath =>
  invokeNative('git_branch_list', { repoPath: String(repoPath ?? '') })

const baseBranchList: GitBridge['baseBranchList'] = async repoPath =>
  invokeNative('git_base_branch_list', { repoPath: String(repoPath ?? '') })

const repoStatus: GitBridge['repoStatus'] = async repoPath =>
  invokeNative('git_repo_status', { repoPath: String(repoPath ?? '') })

const fileDiff: GitBridge['fileDiff'] = async (repoPath, filePath) =>
  invokeNative('git_file_diff', {
    repoPath: String(repoPath ?? ''),
    filePath: String(filePath ?? '')
  })

const review: GitBridge['review'] = {
  list: (repoPath, scope, baseRef) =>
    invokeNative('git_review_list', {
      repoPath: String(repoPath ?? ''),
      scope: String(scope ?? 'uncommitted'),
      baseRef: baseRef ?? null
    }),
  diff: (repoPath, filePath, scope, baseRef, staged) =>
    invokeNative('git_review_diff', {
      repoPath: String(repoPath ?? ''),
      filePath: String(filePath ?? ''),
      scope: String(scope ?? 'uncommitted'),
      baseRef: baseRef ?? null,
      staged: staged ?? null
    }),
  stage: (repoPath, filePath) =>
    invokeNative('git_review_stage', {
      repoPath: String(repoPath ?? ''),
      filePath: filePath ?? null
    }),
  unstage: (repoPath, filePath) =>
    invokeNative('git_review_unstage', {
      repoPath: String(repoPath ?? ''),
      filePath: filePath ?? null
    }),
  revert: (repoPath, filePath) =>
    invokeNative('git_review_revert', {
      repoPath: String(repoPath ?? ''),
      filePath: filePath ?? null
    }),
  revParse: (repoPath, refName) =>
    invokeNative('git_review_rev_parse', {
      repoPath: String(repoPath ?? ''),
      refName: refName ?? null
    }),
  commit: (repoPath, message, push) =>
    invokeNative('git_review_commit', {
      repoPath: String(repoPath ?? ''),
      message: String(message ?? ''),
      push: Boolean(push)
    }),
  commitContext: repoPath => invokeNative('git_review_commit_context', { repoPath: String(repoPath ?? '') }),
  push: repoPath => invokeNative('git_review_push', { repoPath: String(repoPath ?? '') }),
  shipInfo: repoPath => invokeNative('git_review_ship_info', { repoPath: String(repoPath ?? '') }),
  prList: (repoPath, branches, numbers) =>
    invokeNative('git_review_pr_list', {
      repoPath: String(repoPath ?? ''),
      branches: Array.isArray(branches) ? branches : [],
      numbers: numbers ?? null
    }),
  createPr: repoPath => invokeNative('git_review_create_pr', { repoPath: String(repoPath ?? '') })
}

export const gitBridge: GitBridge = {
  scanRepos,
  worktreeList,
  worktreeAdd,
  worktreeRemove,
  branchSwitch,
  branchList,
  baseBranchList,
  repoStatus,
  fileDiff,
  review
}
