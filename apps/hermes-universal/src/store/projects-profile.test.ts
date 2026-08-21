import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GatewayModule from '@/store/gateway'

const { getHermesConfig, localRepoScanSupported, requestGateway, scanRepos, setApiRequestProfile } = vi.hoisted(() => ({
  getHermesConfig: vi.fn(async () => ({}) as unknown),
  localRepoScanSupported: vi.fn(() => true),
  requestGateway: vi.fn(async (_method: string, _params?: unknown) => ({ active_id: null, projects: [] })),
  scanRepos: vi.fn(async () => [{ label: 'app', root: '/home/dev/app' }]),
  setApiRequestProfile: vi.fn()
}))

vi.mock('@/lib/desktop-git', () => ({ desktopGit: vi.fn(() => ({ scanRepos })) }))
vi.mock('@/store/repo-scan', () => ({ localRepoScanSupported, scanLocalGitRepos: vi.fn() }))
vi.mock('@/hermes', () => ({ getHermesConfig, setApiRequestProfile }))
vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<typeof GatewayModule>()),
  requestGateway
}))

import { $activeProfile } from '@/store/profiles'

import {
  addProjectFolder,
  createProject,
  deleteProject,
  fetchProjectSessions,
  refreshProjects,
  refreshProjectTree,
  scanAndRecordRepos,
  setActiveProject,
  updateProject
} from './projects'

/** Params the gateway saw for `method`, or undefined if it was never called. */
const paramsFor = (method: string) =>
  requestGateway.mock.calls.find(([name]) => name === method)?.[1] as Record<string, unknown> | undefined

beforeEach(() => {
  requestGateway.mockClear()
  requestGateway.mockReset()
  requestGateway.mockResolvedValue({ active_id: null, projects: [] })
  getHermesConfig.mockReset()
  getHermesConfig.mockResolvedValue({})
  localRepoScanSupported.mockReturnValue(true)
})

/**
 * Every `projects.*` handler is `@_profile_scoped` on the gateway and reads
 * `params['profile']` to choose which profile's `projects.db` it opens. The
 * fixture focuses a profile the gateway was NOT launched as, so a call that
 * forgets the stamp still succeeds — against the wrong database. That is the
 * failure this suite exists to catch.
 */
describe('projects.* carry the focused profile', () => {
  beforeEach(() => $activeProfile.set('research'))

  it('stamps the profile on every read', async () => {
    await refreshProjects()
    await refreshProjectTree()
    await fetchProjectSessions('p1')

    expect(paramsFor('projects.list')).toEqual({ profile: 'research' })
    expect(paramsFor('projects.tree')).toEqual({ preview_limit: 3, profile: 'research' })
    expect(paramsFor('projects.project_sessions')).toEqual({ project_id: 'p1', profile: 'research' })
  })

  it('stamps the profile on every write', async () => {
    requestGateway.mockResolvedValue({ active_id: null, project: { id: 'p1' }, projects: [] } as never)

    await createProject({ name: 'New', primaryPath: '/w' })
    await updateProject('p1', { color: 'red' })
    await addProjectFolder('p1', '/w/extra')
    await setActiveProject('p1')
    await deleteProject('p1')
    await scanAndRecordRepos(true)

    for (const method of [
      'projects.create',
      'projects.update',
      'projects.add_folder',
      'projects.set_active',
      'projects.delete',
      'projects.record_repos'
    ]) {
      expect(paramsFor(method)).toMatchObject({ profile: 'research' })
    }

    // The payload the handler needs must survive the stamping.
    expect(paramsFor('projects.add_folder')).toMatchObject({ id: 'p1', path: '/w/extra' })
    expect(paramsFor('projects.record_repos')).toMatchObject({ repos: [{ label: 'app', root: '/home/dev/app' }] })
  })

  it('stamps the profile on the gateway-side scan the remote clients use', async () => {
    // The one discovery call a remote/cloud gateway or a phone makes. Unstamped
    // it would scan into — and cache into — the LAUNCH profile's projects.db,
    // while the `projects.tree` read that follows it reads the focused one.
    localRepoScanSupported.mockReturnValue(false)
    requestGateway.mockImplementation(async (method: string) =>
      method === 'projects.discover_repos'
        ? { discovery_policy: { enabled: true }, repos: [] }
        : { active_id: null, projects: [] }
    )

    await scanAndRecordRepos(true)

    expect(paramsFor('projects.discover_repos')).toEqual({ profile: 'research', scan: true })
  })

  // The default profile is the gateway's own: omitting the key (rather than
  // sending "default") is what keeps single-profile requests unchanged.
  it('omits the key entirely on the default profile', async () => {
    $activeProfile.set(null)

    await refreshProjects()
    await refreshProjectTree()

    expect(paramsFor('projects.list')).toEqual({})
    expect(paramsFor('projects.tree')).toEqual({ preview_limit: 3 })
  })
})
