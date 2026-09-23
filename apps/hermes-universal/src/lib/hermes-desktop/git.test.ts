import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}))

describe('gitBridge', () => {
  beforeEach(() => {
    invoke.mockReset()
    vi.resetModules()
  })

  it('scanRepos maps onto repo_scan_git_repos and soft-fails', async () => {
    invoke.mockResolvedValue([{ root: '/work/a', label: 'a' }])

    const { gitBridge } = await import('./git')
    await expect(gitBridge.scanRepos(['~/code'], { enabled: true, excludePaths: ['~/Library'] })).resolves.toEqual([
      { root: '/work/a', label: 'a' }
    ])

    invoke.mockRejectedValue(new Error('boom'))
    await expect(gitBridge.scanRepos(['~/code'])).resolves.toEqual([])
  })

  it('worktree, branch, status, and review ops pass through', async () => {
    invoke.mockResolvedValue({})

    const { gitBridge } = await import('./git')
    await gitBridge.worktreeList('/repo')
    await gitBridge.repoStatus('/repo')
    await gitBridge.fileDiff('/repo', 'a.ts')
    await gitBridge.review.list('/repo', 'uncommitted')
    await gitBridge.review.diff('/repo', 'a.ts', 'uncommitted', null, false)
    await gitBridge.review.stage('/repo', 'a.ts')
    await gitBridge.review.shipInfo('/repo')
    await gitBridge.review.prList('/repo', ['main'], [1])
    await gitBridge.review.createPr('/repo')

    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      'git_worktree_list',
      'git_repo_status',
      'git_file_diff',
      'git_review_list',
      'git_review_diff',
      'git_review_stage',
      'git_review_ship_info',
      'git_review_pr_list',
      'git_review_create_pr'
    ])
  })
})
