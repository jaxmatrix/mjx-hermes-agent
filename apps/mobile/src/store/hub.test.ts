import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  installSkillFromHub: vi.fn(async () => ({ name: 'act-install', ok: true, pid: 1 })),
  uninstallSkillFromHub: vi.fn(async () => ({ name: 'act-uninstall', ok: true, pid: 1 })),
  updateSkillsFromHub: vi.fn(async () => ({ name: 'act-update', ok: true, pid: 1 })),
  getActionStatus: vi.fn(async () => ({ running: false, exit_code: 0, lines: [], name: 'x', pid: 1 })),
  // refreshCapabilities() (skills store) calls these on success.
  getSkills: vi.fn(async () => []),
  getToolsets: vi.fn(async () => [])
}))

import { getActionStatus, installSkillFromHub } from '@/hermes'

import { $hubActions, installFromHub } from './hub'

const status = vi.mocked(getActionStatus)
const install = vi.mocked(installSkillFromHub)

describe('hub actions', () => {
  beforeEach(() => {
    status.mockClear()
    install.mockClear()
    $hubActions.set({})
  })
  afterEach(() => $hubActions.set({}))

  it('installs, polls status to completion, and clears its running entry', async () => {
    const ok = await installFromHub('acme/skill')
    expect(ok).toBe(true)
    expect(install).toHaveBeenCalledWith('acme/skill')
    expect(status).toHaveBeenCalledWith('act-install')
    expect($hubActions.get()['acme/skill']).toBeUndefined()
  })

  it('reports failure on a non-zero exit code', async () => {
    status.mockResolvedValueOnce({ running: false, exit_code: 1, lines: [], name: 'act-install', pid: 1 })
    const ok = await installFromHub('bad/skill')
    expect(ok).toBe(false)
  })
})
