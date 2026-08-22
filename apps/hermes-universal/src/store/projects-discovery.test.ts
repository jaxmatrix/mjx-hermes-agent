import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GatewayModule from '@/store/gateway'

const { getHermesConfig, localRepoScanSupported, requestGateway, scanRepos, setApiRequestProfile } = vi.hoisted(() => ({
  getHermesConfig: vi.fn(async () => ({}) as unknown),
  // The client's own disk speaks for the gateway only when the backend was
  // spawned here; that is the switch between the two discovery paths.
  localRepoScanSupported: vi.fn(() => true),
  // The return type is declared, not inferred: inferring it from this one
  // literal pins the mock to `{active_id: null; projects: never[]}`, and every
  // later mockImplementation returning a different RPC's shape then fails to
  // typecheck (MJXHRM-474 / #269, fixed forward here).
  requestGateway: vi.fn(async (_method: string, _params?: unknown): Promise<Record<string, unknown>> => ({
    active_id: null,
    projects: []
  })),
  scanRepos: vi.fn(async () => [{ label: 'app', root: '/home/dev/app' }]),
  // store/projects → store/session → store/profile → store/profiles, which syncs
  // the REST scope at import time.
  setApiRequestProfile: vi.fn()
}))

vi.mock('@/lib/desktop-git', () => ({ desktopGit: vi.fn(() => ({ scanRepos })) }))
vi.mock('@/store/repo-scan', () => ({ localRepoScanSupported, scanLocalGitRepos: vi.fn() }))
vi.mock('@/hermes', () => ({ getHermesConfig, setApiRequestProfile }))
// Partial mock: store/connection subscribes to `$gatewayState` at import time.
vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<typeof GatewayModule>()),
  requestGateway
}))

import { $connection } from '@/store/connection'

import {
  $reposScanning,
  repoDiscoveryPolicyFromConfig,
  repoDiscoveryPolicySignature,
  scanAndRecordRepos
} from './projects'

const recordCalls = () => requestGateway.mock.calls.filter(([method]) => method === 'projects.record_repos')

beforeEach(() => {
  scanRepos.mockClear()
  requestGateway.mockClear()
  requestGateway.mockResolvedValue({ active_id: null, projects: [] })
  getHermesConfig.mockReset()
  getHermesConfig.mockResolvedValue({})
  localRepoScanSupported.mockReturnValue(true)
  $reposScanning.set(false)
})

describe('repository discovery policy', () => {
  it('defaults to enabled with no roots when config is absent', () => {
    expect(repoDiscoveryPolicyFromConfig({})).toEqual({ enabled: true, exclude_paths: [], roots: [] })
    expect(repoDiscoveryPolicyFromConfig(null)).toEqual({ enabled: true, exclude_paths: [], roots: [] })
  })

  it('reads the desktop.repo_scan_* block and drops non-string entries', () => {
    const policy = repoDiscoveryPolicyFromConfig({
      desktop: {
        repo_scan_enabled: false,
        repo_scan_exclude_paths: ['~/Library', 7],
        repo_scan_roots: ['~/code', null, 'work']
      }
    })

    expect(policy).toEqual({
      enabled: false,
      exclude_paths: ['~/Library'],
      roots: ['~/code', 'work']
    })
  })

  it('only treats an explicit false as disabled', () => {
    expect(repoDiscoveryPolicyFromConfig({ desktop: { repo_scan_enabled: undefined } }).enabled).toBe(true)
    expect(repoDiscoveryPolicyFromConfig({ desktop: { repo_scan_enabled: false } }).enabled).toBe(false)
  })

  it('signs equal policies identically', () => {
    const policy = { enabled: true, exclude_paths: [], roots: ['~/code'] }

    expect(repoDiscoveryPolicySignature(policy)).toBe(repoDiscoveryPolicySignature({ ...policy }))
  })
})

describe('scanAndRecordRepos', () => {
  it('scans and records the crawl result with the policy that produced it', async () => {
    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_roots: ['~/code'] } })

    await scanAndRecordRepos()

    expect(scanRepos).toHaveBeenCalledWith(['~/code'], { enabled: true, excludePaths: [] })
    expect(recordCalls()).toEqual([
      [
        'projects.record_repos',
        {
          discovery_policy: { enabled: true, exclude_paths: [], roots: ['~/code'] },
          repos: [{ label: 'app', root: '/home/dev/app' }]
        }
      ]
    ])
    expect($reposScanning.get()).toBe(false)
  })

  it('records an empty list without crawling when discovery is disabled', async () => {
    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_enabled: false } })

    await scanAndRecordRepos()

    expect(scanRepos).not.toHaveBeenCalled()
    expect(recordCalls()[0]?.[1]).toMatchObject({ repos: [] })
  })

  it('skips a repeat of the same policy unless forced', async () => {
    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_roots: ['~/repeat'] } })

    await scanAndRecordRepos()
    await scanAndRecordRepos()

    expect(scanRepos).toHaveBeenCalledTimes(1)

    await scanAndRecordRepos(true)

    expect(scanRepos).toHaveBeenCalledTimes(2)
  })

  it('rescans when the policy changes', async () => {
    // The "already ran" memo is module state that outlives one test, so use
    // roots no other case here has scanned.
    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_roots: ['~/alpha'] } })
    await scanAndRecordRepos()

    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_roots: ['~/beta'] } })
    await scanAndRecordRepos()

    expect(scanRepos).toHaveBeenCalledTimes(2)
    expect(scanRepos).toHaveBeenNthCalledWith(2, ['~/beta'], { enabled: true, excludePaths: [] })
  })

  it('clears the scanning flag and stays retryable after a failure', async () => {
    getHermesConfig.mockRejectedValueOnce(new Error('offline'))

    await scanAndRecordRepos()

    expect($reposScanning.get()).toBe(false)
    expect(recordCalls()).toHaveLength(0)

    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_roots: ['~/retry'] } })
    await scanAndRecordRepos()

    expect(scanRepos).toHaveBeenCalledTimes(1)
  })
})

/**
 * When the client's disk is NOT the gateway's — a remote/cloud gateway, or
 * mobile, which has no crawlable disk — discovery is the gateway walking its own
 * `desktop.repo_scan_*` roots (`projects.discover_repos {scan: true}`). This
 * replaced the fork's `GET /api/git/scan-repos`, a second server-side walk of
 * that same policy (MJXHRM-474).
 *
 * The fixtures deliberately return repos the client could not have produced: a
 * remote gateway's repos live on ITS filesystem, and `sessions: 0` is the whole
 * point — a repo the disk scan found that has never hosted a Hermes session.
 */
describe('scanAndRecordRepos against a gateway that owns the disk', () => {
  const discoverCalls = () => requestGateway.mock.calls.filter(([method]) => method === 'projects.discover_repos')

  // The "already scanned" memo is module state that outlives one test, and a
  // reconnect is what clears it — so each case starts on its own connection.
  let connections = 0

  const freshConnection = () =>
    $connection.set({ baseUrl: `https://g${++connections}.example`, mode: 'remote' } as never)

  beforeEach(() => {
    freshConnection()
    localRepoScanSupported.mockReturnValue(false)
    requestGateway.mockImplementation(async (method: string) =>
      method === 'projects.discover_repos'
        ? {
            discovery_policy: { enabled: true },
            repos: [{ label: 'srv', last_active: 0, root: '/srv/srv', sessions: 0 }]
          }
        : { active_id: null, projects: [] }
    )
  })

  it('asks the gateway to scan its own roots instead of crawling or recording', async () => {
    await scanAndRecordRepos(true)

    expect(discoverCalls()).toEqual([['projects.discover_repos', { scan: true }]])
    // Nothing local to crawl...
    expect(scanRepos).not.toHaveBeenCalled()
    // ...and nothing to record: the RPC wrote the gateway's own cache, so
    // posting its merged answer back would overwrite that cache with
    // session-derived repos.
    expect(recordCalls()).toHaveLength(0)
    // The tree is re-read so the newly cached repos actually reach the sidebar.
    expect(requestGateway.mock.calls.some(([method]) => method === 'projects.tree')).toBe(true)
    expect($reposScanning.get()).toBe(false)
  })

  it('keeps the sidebar list when the backend answers without a repo list', async () => {
    // A backend too old to know `scan` returns something that is not the
    // discovery shape. Refreshing the tree on that would blank the sidebar back
    // to the silent, unpopulated state the scan exists to fix.
    requestGateway.mockImplementation(async (method: string) =>
      method === 'projects.discover_repos' ? { accepted: false } : { active_id: null, projects: [] }
    )

    await scanAndRecordRepos(true)

    expect(requestGateway.mock.calls.some(([method]) => method === 'projects.tree')).toBe(false)
    expect($reposScanning.get()).toBe(false)
  })

  it('stays retryable after a rejected scan and does not memo the failure', async () => {
    requestGateway.mockRejectedValueOnce(new Error('gateway dropped'))

    await scanAndRecordRepos(true)

    expect($reposScanning.get()).toBe(false)

    await scanAndRecordRepos()

    expect(discoverCalls()).toHaveLength(2)
  })

  it('scans once per connection unless forced, and again after a reconnect', async () => {
    // The gateway reads its own policy and never tells us before scanning, so
    // the memo is one sentinel per connection rather than a policy signature.
    await scanAndRecordRepos()
    await scanAndRecordRepos()

    expect(discoverCalls()).toHaveLength(1)

    await scanAndRecordRepos(true)

    expect(discoverCalls()).toHaveLength(2)

    // A different gateway has a different disk and a different cache, so the
    // memo must not carry across the reconnect.
    freshConnection()

    await scanAndRecordRepos()

    expect(discoverCalls()).toHaveLength(3)
  })
})
