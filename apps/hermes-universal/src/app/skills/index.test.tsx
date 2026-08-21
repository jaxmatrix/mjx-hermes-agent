// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'
import { $settingsScopeOverride } from '@/store/settings-scope'

// This is a full mount → useQuery → master-detail → on-mount config-fetch
// integration test. In isolation it settles in <100ms, but inside the ~80-file
// parallel suite the CPU is saturated and that async chain can exceed vitest's
// 5s default — which then skips unmount and pollutes the next test ("multiple
// elements"). Give the heavy path room; correctness is unchanged.
vi.setConfig({ testTimeout: 30000 })
configure({ asyncUtilTimeout: 15000 })

const getSkills = vi.fn()
const getToolsets = vi.fn()
const toggleSkill = vi.fn()
const toggleToolset = vi.fn()
const getToolsetConfig = vi.fn()
const selectToolsetProvider = vi.fn()
const getUsageAnalytics = vi.fn()
const getSkillHubSources = vi.fn()
const installSkillFromHub = vi.fn()
const getActionStatus = vi.fn()

// Partial mock: keep the real module (SkillsView pulls in @/store/profile,
// whose import-time subscription calls setApiRequestProfile) and stub only the
// calls we assert on.
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getSkills: (profile?: null | string) => getSkills(profile),
  getToolsets: () => getToolsets(),
  toggleSkill: (name: string, enabled: boolean, profile?: null | string) => toggleSkill(name, enabled, profile),
  toggleToolset: (name: string, enabled: boolean) => toggleToolset(name, enabled),
  getToolsetConfig: (name: string) => getToolsetConfig(name),
  selectToolsetProvider: (toolset: string, provider: string) => selectToolsetProvider(toolset, provider),
  getUsageAnalytics: (days: number) => getUsageAnalytics(days),
  getSkillHubSources: (profile?: null | string) => getSkillHubSources(profile),
  installSkillFromHub: (identifier: string, profile?: null | string) => installSkillFromHub(identifier, profile),
  getActionStatus: (name: string, tail?: number) => getActionStatus(name, tail)
}))

// Notifications hit nanostores/timers we don't care about here.
vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

function toolset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'web',
    label: 'Web Search',
    description: 'web_search, web_extract',
    enabled: true,
    available: true,
    configured: true,
    tools: ['web_search', 'web_extract'],
    ...overrides
  }
}

async function renderSkills(route = '/skills?tab=toolsets') {
  const { SkillsView } = await import('./index')
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      // SkillsView reads skills/toolsets via useQuery, so it needs a provider.
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <SkillsView />
        </MemoryRouter>
      </QueryClientProvider>
    )
  })

  return result!
}

beforeEach(() => {
  getSkills.mockResolvedValue([])
  getToolsets.mockResolvedValue([toolset()])
  toggleToolset.mockResolvedValue({ ok: true, name: 'web', enabled: false })
  getToolsetConfig.mockResolvedValue({ has_category: true, active_provider: null, providers: [] })
  getUsageAnalytics.mockResolvedValue({ tools: [] })
  getSkillHubSources.mockResolvedValue({ sources: [], featured: [], installed: {} })
  installSkillFromHub.mockResolvedValue({ name: 'skill-install-1' })
  getActionStatus.mockResolvedValue({ name: 'skill-install-1', running: false, exit_code: 0, lines: [] })
  toggleSkill.mockResolvedValue({ ok: true, name: 'pdf', enabled: false })
})

afterEach(() => {
  $settingsScopeOverride.set(null)
  cleanup()
  vi.clearAllMocks()
  // Shared singleton client — drop cached skills/toolsets so each test refetches.
  queryClient.clear()
})

describe('SkillsView toolset management', () => {
  it('renders a switch for each toolset and toggles it off', async () => {
    await renderSkills()

    const sw = await screen.findByRole('switch', { name: 'Toggle Web Search toolset' })
    expect(sw.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      fireEvent.click(sw)
    })

    await waitFor(() => expect(toggleToolset).toHaveBeenCalledWith('web', false))
  })

  it('renders toolset titles without leading emoji', async () => {
    getToolsets.mockResolvedValue([toolset({ name: 'cronjob', label: '⏰ Cron Jobs', description: 'cron tools' })])

    await renderSkills()

    // The label renders in both the row and the auto-selected detail header, so
    // assert via the switch's (emoji-stripped) accessible name and the absence
    // of the emoji rather than a single-match text lookup.
    await screen.findByRole('switch', { name: 'Toggle Cron Jobs toolset' })
    expect(screen.queryByText(/⏰/)).toBeNull()
  })

  it('renders the provider config panel inline for the selected toolset', async () => {
    // The master-detail UI dropped the resting "Configured" pill and the
    // "Configure" expander: the detail column auto-selects the first toolset
    // and renders its config panel directly, which fetches on mount.
    await renderSkills()

    await screen.findByRole('switch', { name: 'Toggle Web Search toolset' })
    await waitFor(() => expect(getToolsetConfig).toHaveBeenCalledWith('web'))
  })
})

describe('SkillsView hub browser', () => {
  // The fixture disagrees with the layout on purpose: ZERO installed skills is
  // the state the old code replaced the whole pane with an empty panel in, and
  // it is exactly the user who needs the hub. The hub has to outlive it.
  it('docks the hub browser in the Skills tab even with nothing installed', async () => {
    getSkills.mockResolvedValue([])

    await renderSkills('/skills?tab=skills')

    // 'Connected hubs:' is rendered by the hub browser and by nothing else.
    expect(await screen.findByText('Connected hubs:')).toBeTruthy()
  })

  it('drops the standalone Browse Hub tab', async () => {
    getSkills.mockResolvedValue([])

    await renderSkills('/skills?tab=skills')

    await screen.findByText('Connected hubs:')
    // The label survives as the docked pane's title (a span); what must be
    // gone is the TAB, which is the only button that ever carried it.
    expect(screen.queryAllByRole('button', { name: 'Browse Hub' })).toHaveLength(0)
  })

  it('keeps the hub out of the Tools tab', async () => {
    getSkills.mockResolvedValue([])

    await renderSkills('/skills?tab=toolsets')

    await screen.findByRole('switch', { name: 'Toggle Web Search toolset' })
    expect(screen.queryByText('Connected hubs:')).toBeNull()
  })

  it('routes a legacy ?tab=hub link to the Skills tab', async () => {
    getSkills.mockResolvedValue([])

    await renderSkills('/skills?tab=hub')

    // Falls back to 'skills' (useRouteEnumParam drops unknown values), which
    // is where the hub now lives — the link keeps working.
    expect(await screen.findByText('Connected hubs:')).toBeTruthy()
  })
})

describe('SkillsView profile scope', () => {
  // The fixture disagrees on purpose: the app-wide profile is the default, and
  // the Capabilities scope points somewhere else. Every read and write has to
  // follow the SCOPE, not the app.
  const scoped = async () => {
    $settingsScopeOverride.set('research')
    getSkills.mockResolvedValue([{ name: 'pdf', description: 'pdf things', category: 'docs', enabled: true }])

    return renderSkills('/skills?tab=skills')
  }

  it("lists the scoped profile's skills, not the active profile's", async () => {
    await scoped()

    await waitFor(() => expect(getSkills).toHaveBeenCalledWith('research'))
  })

  it('toggles a skill on the scoped profile', async () => {
    await scoped()

    const sw = await screen.findByRole('switch', { name: 'pdf' })
    await act(async () => {
      fireEvent.click(sw)
    })

    await waitFor(() => expect(toggleSkill).toHaveBeenCalledWith('pdf', false, 'research'))
  })

  it('installs a hub skill into the scoped profile', async () => {
    getSkillHubSources.mockResolvedValue({
      sources: [],
      featured: [{ identifier: 'acme/pdf-tools', name: 'pdf-tools', description: '', trust_level: 'community' }],
      installed: {}
    })

    await scoped()

    const install = await screen.findByRole('button', { name: 'Install' })
    await act(async () => {
      fireEvent.click(install)
    })

    await waitFor(() => expect(installSkillFromHub).toHaveBeenCalledWith('acme/pdf-tools', 'research'))
  })

  it('reads the hub under the scoped profile', async () => {
    await scoped()

    await waitFor(() => expect(getSkillHubSources).toHaveBeenCalledWith('research'))
  })
})
