import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/model'
import { $activeGatewayProfile } from '@/store/profile'

import { $projects, $projectsRpcAvailable, $projectTree, setProjectAppearance } from './projects'

const { gateway, request } = vi.hoisted(() => {
  const request = vi.fn()
  const gateway = { connectionState: 'open' as const, request }

  return { gateway, request }
})

vi.mock('@/store/gateway', () => ({
  $gateway: atom(null),
  activeGateway: vi.fn(() => gateway),
  ensureActiveGatewayOpen: vi.fn(async () => gateway)
}))

vi.mock('@/hermes', () => ({
  getApiRequestConnection: () => null,
  getApiRequestProfile: () => 'default',
  setApiRequestProfile: vi.fn()
}))

const node = (patch: Partial<SidebarProjectTree> = {}): SidebarProjectTree => ({
  id: 'p_app',
  label: 'App',
  path: '/www/app',
  repos: [],
  sessionCount: 0,
  ...patch
})

beforeEach(() => {
  request.mockReset()
  request.mockResolvedValue({} as never)
  $projects.set([])
  $projectTree.set([])
  $projectsRpcAvailable.set(true)
  $activeGatewayProfile.set('default')
})

describe('setProjectAppearance', () => {
  it('patches a real project in place and does not materialize', async () => {
    $projectTree.set([node({ color: '#111111' })])

    await expect(setProjectAppearance(node({ color: '#111111' }), { color: '#4a9eff' })).resolves.toBe(false)

    expect(request).toHaveBeenCalledWith('projects.update', expect.objectContaining({ id: 'p_app', color: '#4a9eff' }))
    expect($projectTree.get()[0].color).toBe('#4a9eff')
  })

  it('clears a color with the empty string the backend reads as "clear"', async () => {
    $projectTree.set([node({ color: '#4a9eff' })])

    await setProjectAppearance(node({ color: '#4a9eff' }), { color: null })

    expect(request).toHaveBeenCalledWith('projects.update', expect.objectContaining({ id: 'p_app', color: '' }))
  })

  // An inherited (auto) project is a git repo root with no projects.db row, so
  // there is no id to PATCH — theming it has to create the row.
  it('materializes an inherited project into a real one', async () => {
    request.mockResolvedValue({
      project: { id: 'p_new', name: 'App', color: '#4a9eff', folders: [] }
    } as never)

    await expect(setProjectAppearance(node({ id: '/www/app', isAuto: true }), { color: '#4a9eff' })).resolves.toBe(true)

    expect(request).toHaveBeenCalledWith(
      'projects.create',
      expect.objectContaining({ name: 'App', folders: ['/www/app'], primary_path: '/www/app', color: '#4a9eff' })
    )
  })

  it('carries the already-set field so setting one does not wipe the other', async () => {
    request.mockResolvedValue({ project: null } as never)

    await setProjectAppearance(node({ id: '/www/app', color: '#4a9eff', isAuto: true }), { icon: 'rocket' })

    expect(request).toHaveBeenCalledWith(
      'projects.create',
      expect.objectContaining({ color: '#4a9eff', icon: 'rocket' })
    )
  })

  it('does nothing for an inherited project with no path to anchor to', async () => {
    await expect(setProjectAppearance(node({ id: 'auto', isAuto: true, path: null }), { color: '#fff' })).resolves.toBe(
      false
    )

    expect(request).not.toHaveBeenCalled()
  })
})
