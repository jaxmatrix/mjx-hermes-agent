/**
 * MJXHRM-423 — "Move to project" addressed by a pre-rotation id.
 *
 * `session.workspace.move` writes `cwd` / `git_repo_root` onto ONE row, and
 * `list_sessions_rich` projects a compression chain onto its live tip — so those
 * columns are read off the TIP no matter which segment they were written to.
 */

import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

const { gateway, workspaceMove } = vi.hoisted(() => {
  const workspaceMove = vi.fn()

  return {
    gateway: { connectionState: 'open' as const, request: workspaceMove },
    workspaceMove
  }
})

vi.mock('@/i18n', () => ({
  translateNow: (key: string) => key
}))

vi.mock('@/hermes', () => ({
  getApiRequestConnection: () => null,
  getApiRequestProfile: () => 'default',
  deleteSession: vi.fn(),
  getHermesConfig: vi.fn(),
  getProfiles: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  hermesApi: vi.fn(),
  listAllProfileSessions: vi.fn(async () => ({ sessions: [], total: 0 })),
  renameSession: vi.fn(),
  searchSessions: vi.fn(),
  setApiRequestProfile: vi.fn(),
  setSessionArchived: vi.fn(),
  STARTUP_REQUEST_TIMEOUT_MS: 1000
}))

vi.mock('@/lib/desktop-fs', () => ({
  desktopDefaultCwd: vi.fn(),
  isDesktopFsRemoteMode: vi.fn(),
  selectDesktopPaths: vi.fn(),
  writeDesktopFileText: vi.fn()
}))

vi.mock('@/lib/desktop-git', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  desktopGit: vi.fn()
}))

vi.mock('@/store/gateway', () => ({
  $gateway: atom(null),
  activeGateway: vi.fn(() => gateway),
  ensureActiveGatewayOpen: vi.fn(async () => gateway)
}))

vi.mock('@/store/session-lookup', () => ({
  liveSessionIdFor: (storedSessionId: string) => (storedSessionId === 'root' ? 'tip' : storedSessionId)
}))

vi.mock('@/store/gateway-client', async () => {
  const { atom: atomFn } = await import('@/store/atom')

  return {
    $gatewayState: atomFn('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: vi.fn(async () => ({ projects: [] }))
  }
})

import { $activeGatewayProfile } from '@/store/profile'

import { $projectTree, moveSessionToProject } from './projects'
import { $sessions } from './session'

beforeEach(() => {
  $activeGatewayProfile.set('default')
})

afterEach(() => {
  $sessions.set([])
  $projectTree.set([])
  vi.clearAllMocks()
})

const compacted = { _lineage_root_id: 'root', id: 'tip', cwd: '/old/app' } as unknown as SessionInfo

beforeEach(() => {
  workspaceMove.mockResolvedValue({ cwd: '/moved/app', git_repo_root: '/moved' })
  $projectTree.set([{ id: 'proj-moved', label: 'Moved', path: '/moved/app', repos: [], sessionCount: 0 }])
})

describe('moveSessionToProject', () => {
  it('re-homes the live tip when handed the lineage root', async () => {
    $sessions.set([compacted])

    await moveSessionToProject('root', 'proj-moved')

    expect(workspaceMove).toHaveBeenCalledWith('session.workspace.move', {
      cwd: '/moved/app',
      session_key: 'tip'
    })
  })

  it('patches the row the backend actually moved', async () => {
    $sessions.set([compacted])

    const frames: (readonly SessionInfo[])[] = []
    const off = $sessions.listen(next => frames.push(next))

    await moveSessionToProject('root', 'proj-moved')
    off()

    expect(frames[0]?.[0]).toMatchObject({ cwd: '/moved/app', git_repo_root: '/moved', id: 'tip' })
  })

  it('sends the id as given when no source has seen the session', async () => {
    await moveSessionToProject('unknown-1', 'proj-moved')

    expect(workspaceMove).toHaveBeenCalledWith('session.workspace.move', {
      cwd: '/moved/app',
      session_key: 'unknown-1'
    })
  })

  it('refuses a move with no project folder', async () => {
    $projectTree.set([{ id: 'empty', label: 'Empty', path: null, repos: [], sessionCount: 0 }])

    await expect(moveSessionToProject('root', 'empty')).rejects.toThrow(/sidebar\.projects\.moveNoFolder/)
    expect(workspaceMove).not.toHaveBeenCalled()
  })
})
