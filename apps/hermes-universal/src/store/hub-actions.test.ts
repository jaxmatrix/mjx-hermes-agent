import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'

const getActionStatus = vi.fn()
const installSkillFromHub = vi.fn()
const uninstallSkillFromHub = vi.fn()
const updateSkillsFromHub = vi.fn()

// Partial mock: the real module still has to load (store/profile subscribes to
// it at import time), only the four calls this store makes are stubbed.
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getActionStatus: (name: string, tail?: number) => getActionStatus(name, tail),
  installSkillFromHub: (identifier: string, profile?: null | string) => installSkillFromHub(identifier, profile),
  uninstallSkillFromHub: (name: string, profile?: null | string) => uninstallSkillFromHub(name, profile),
  updateSkillsFromHub: (profile?: null | string) => updateSkillsFromHub(profile)
}))

// The activity store fans a finished action out to the task list; irrelevant here.
vi.mock('@/store/activity', () => ({ upsertDesktopActionTask: vi.fn() }))

const finished = (overrides: Record<string, unknown> = {}) => ({
  name: 'skills-install-1',
  running: false,
  exit_code: 0,
  lines: [],
  ...overrides
})

beforeEach(() => {
  installSkillFromHub.mockResolvedValue({ name: 'skills-install-1' })
  uninstallSkillFromHub.mockResolvedValue({ name: 'skills-uninstall-1' })
  updateSkillsFromHub.mockResolvedValue({ name: 'skills-update-1' })
  getActionStatus.mockResolvedValue(finished())
})

afterEach(() => vi.clearAllMocks())

describe('hub actions', () => {
  it("rejects with the action log's reason when the install exits non-zero", async () => {
    // Disagreeing fixture: the spawn SUCCEEDS and the poll comes back cleanly —
    // only the exit code says it failed. That is the shape that used to resolve
    // silently, leaving "Installing…" as the last thing the user saw.
    getActionStatus.mockResolvedValue(
      finished({ exit_code: 1, lines: ['fetching…', '[31mError: no such skill "nope"[0m'] })
    )

    const { installHubSkill } = await import('./hub-actions')

    await expect(installHubSkill('acme/nope')).rejects.toThrow('Error: no such skill "nope"')
  })

  it('falls back to the exit code when the action logged nothing', async () => {
    getActionStatus.mockResolvedValue(finished({ exit_code: 2, lines: [] }))

    const { installHubSkill } = await import('./hub-actions')

    await expect(installHubSkill('acme/quiet')).rejects.toThrow('exit 2')
  })

  it('resolves and flips the row on a clean exit', async () => {
    const { $hubInstalledOverride, installHubSkill } = await import('./hub-actions')

    await installHubSkill('acme/ok')

    expect($hubInstalledOverride.get()['acme/ok']).toBe(true)
  })

  it('does not flip the row when the install failed', async () => {
    getActionStatus.mockResolvedValue(finished({ exit_code: 1, lines: ['boom'] }))

    const { $hubInstalledOverride, installHubSkill } = await import('./hub-actions')

    await expect(installHubSkill('acme/broken')).rejects.toThrow('boom')
    expect($hubInstalledOverride.get()['acme/broken']).toBeUndefined()
  })

  it('targets the profile the caller passed, not the active one', async () => {
    const { installHubSkill, uninstallHubSkill, updateHubSkills } = await import('./hub-actions')

    await installHubSkill('acme/pdf', 'research')
    await uninstallHubSkill('acme/pdf', 'pdf', 'research')
    await updateHubSkills('research')

    expect(installSkillFromHub).toHaveBeenCalledWith('acme/pdf', 'research')
    expect(uninstallSkillFromHub).toHaveBeenCalledWith('pdf', 'research')
    expect(updateSkillsFromHub).toHaveBeenCalledWith('research')
  })

  it('drops in-flight action state when the Capabilities scope changes', async () => {
    const { $hubActions, $hubInstalledOverride } = await import('./hub-actions')
    const { $settingsScopeOverride } = await import('./settings-scope')

    $hubActions.setKey('acme/pdf', { kind: 'install', running: true, lines: ['…'] })
    $hubInstalledOverride.setKey('acme/pdf', true)

    $settingsScopeOverride.set('research')

    expect($hubActions.get()['acme/pdf']).toBeUndefined()
    expect($hubInstalledOverride.get()['acme/pdf']).toBeUndefined()

    $settingsScopeOverride.set(null)
  })
})
