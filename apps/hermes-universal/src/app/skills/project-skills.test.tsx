// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'

const getProjectSkills = vi.fn()
const setProjectSkillsTrust = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getProjectSkills: (cwd?: null | string, profile?: null | string) => getProjectSkills(cwd, profile),
  setProjectSkillsTrust: (path: string, trusted: boolean, profile?: null | string) =>
    setProjectSkillsTrust(path, trusted, profile)
}))

// The gate only needs the current chat's directory; the chat runtime itself is
// irrelevant here (and enormous). The atom is built INSIDE the factory —
// vi.mock is hoisted above module-level consts, so referencing one from the
// factory is a TDZ error at import time.
vi.mock('@/store/chat', async () => {
  const { atom } = await import('nanostores')

  return { $currentCwd: atom('/repo/src') }
})
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

const skill = (name: string, quarantined = false) => ({
  name,
  path: `/repo/.hermes/skills/${name}/SKILL.md`,
  quarantined
})

async function renderGate(profile?: null | string) {
  const { ProjectSkillsGate } = await import('./project-skills')

  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ProjectSkillsGate profile={profile} />
      </QueryClientProvider>
    )
  })
}

beforeEach(async () => {
  const { $currentCwd } = await import('@/store/chat')

  $currentCwd.set('/repo/src')
  setProjectSkillsTrust.mockResolvedValue({ ok: true, root: '/repo', trusted: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  queryClient.clear()
})

describe('ProjectSkillsGate', () => {
  it('offers the trust decision when the repo carries skills that are not loading', async () => {
    getProjectSkills.mockResolvedValue({
      root: '/repo',
      trusted: false,
      discovery_enabled: true,
      skills: [skill('repo-skill'), skill('other-skill')]
    })

    await renderGate()

    expect(await screen.findByText(/2 skills in this repo are not loaded/)).toBeTruthy()
    expect(screen.getByText('/repo')).toBeTruthy()
  })

  it('sends the resolved ROOT back, not the cwd it asked about', async () => {
    // The disagreeing fixture: the chat sits in a SUBDIRECTORY. Trust is stored
    // by resolved path, so trusting '/repo/src' would silently load nothing.
    getProjectSkills.mockResolvedValue({
      root: '/repo',
      trusted: false,
      discovery_enabled: true,
      skills: [skill('repo-skill')]
    })

    await renderGate('research')

    const button = await screen.findByRole('button', { name: 'Trust this repo' })
    await act(async () => {
      fireEvent.click(button)
    })

    await waitFor(() => expect(setProjectSkillsTrust).toHaveBeenCalledWith('/repo', true, 'research'))
    expect(getProjectSkills).toHaveBeenCalledWith('/repo/src', 'research')
  })

  it('reports quarantined skills and offers to stop trusting', async () => {
    getProjectSkills.mockResolvedValue({
      root: '/repo',
      trusted: true,
      discovery_enabled: true,
      skills: [skill('good'), skill('scary', true)]
    })

    await renderGate()

    expect(await screen.findByText(/1 project skill loaded from this repo/)).toBeTruthy()
    expect(screen.getByText(/1 blocked by the security scan/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop trusting' })).toBeTruthy()
  })

  it('stays invisible outside a checkout', async () => {
    getProjectSkills.mockResolvedValue({ root: null, trusted: false, discovery_enabled: true, skills: [] })

    await renderGate()

    await waitFor(() => expect(getProjectSkills).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('stays invisible in a repo with no project skills', async () => {
    getProjectSkills.mockResolvedValue({ root: '/repo', trusted: false, discovery_enabled: true, skills: [] })

    await renderGate()

    await waitFor(() => expect(getProjectSkills).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
  })
})
