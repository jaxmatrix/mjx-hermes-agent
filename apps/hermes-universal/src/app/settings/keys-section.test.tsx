import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvVarInfo } from '@/types/hermes'

const envVar = (over: Partial<EnvVarInfo>): EnvVarInfo => ({
  advanced: false,
  category: 'tool',
  description: '',
  is_password: true,
  is_set: false,
  redacted_value: null,
  tools: [],
  url: null,
  ...over
})

vi.mock('@/hermes', () => ({
  getEnvVars: vi.fn(async () => ({
    TAVILY_API_KEY: envVar({ category: 'tool', description: 'Tavily search' }),
    GATEWAY_PROXY: envVar({ category: 'setting', is_password: false }),
    // Provider LLM keys live on the Providers page — excluded from Tools & Keys.
    OPENAI_API_KEY: envVar({ category: 'provider', provider_label: 'OpenAI' })
  })),
  setEnvVar: vi.fn(async () => ({ ok: true })),
  revealEnvVar: vi.fn(async (key: string) => ({ key, value: 'super-secret' })),
  deleteEnvVar: vi.fn(async () => ({ ok: true })),
  // Pulled in transitively by the "Applies to" scope (settings-scope ->
  // store/profile -> store/profiles): the roster the chips render, and the
  // REST re-scope store/profiles runs at import time.
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  setApiRequestProfile: vi.fn()
}))

import { getEnvVars, getProfiles, setEnvVar } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { $profiles } from '@/store/profiles'
import { $settingsScopeOverride } from '@/store/settings-scope'

import { KeysSection, type KeysView } from './keys-section'

const setVar = vi.mocked(setEnvVar)
const readVars = vi.mocked(getEnvVars)
const readProfiles = vi.mocked(getProfiles)

const roster = [
  { has_env: true, is_default: true, model: null, name: 'default', path: '/h', provider: null, skill_count: 0 },
  { has_env: true, is_default: false, model: null, name: 'research', path: '/h/r', provider: null, skill_count: 0 }
]

const renderSection = (view: KeysView) =>
  render(
    <I18nProvider>
      <KeysSection view={view} />
    </I18nProvider>
  )

describe('KeysSection (Tools & Keys)', () => {
  beforeEach(() => {
    setVar.mockClear()
    readVars.mockClear()
    $settingsScopeOverride.set(null)
    $profiles.set([])
  })
  afterEach(() => {
    localStorage.clear()
    $settingsScopeOverride.set(null)
    $profiles.set([])
  })

  it('Tools view shows tool credentials and hides settings + provider keys', async () => {
    renderSection('tools')
    expect(await screen.findByText(/tavily/i)).toBeInTheDocument()
    expect(screen.queryByText(/gateway proxy/i)).not.toBeInTheDocument() // Settings view
    expect(screen.queryByText(/openai/i)).not.toBeInTheDocument() // Providers page
  })

  it('Settings view shows setting credentials and hides tool keys', async () => {
    renderSection('settings')
    expect(await screen.findByText(/gateway proxy/i)).toBeInTheDocument()
    expect(screen.queryByText(/tavily/i)).not.toBeInTheDocument()
  })

  it('sets a value for an unset credential', async () => {
    renderSection('settings')
    await screen.findByText(/gateway proxy/i)

    const input = screen.getByRole('textbox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'http://proxy' } })
    fireEvent.click(await screen.findByRole('button', { name: /save/i }))

    // Third arg = the "Applies to" override: undefined means "follow the app's
    // active profile", which is what keeps the request byte-identical for
    // single-profile users.
    await waitFor(() => expect(setVar).toHaveBeenCalledWith('GATEWAY_PROXY', 'http://proxy', undefined))
  })
})

// The whole point of the selector: the page must write to the profile the CHIP
// names, not the one the app is operating as. The fixture deliberately disagrees
// with the app's active profile (which is "default" here) so a save that ignored
// the scope would still look right without this assertion.
describe('KeysSection "Applies to" scope', () => {
  beforeEach(() => {
    setVar.mockClear()
    readVars.mockClear()
    // The selector refreshes the roster on mount, so the fetch has to agree
    // with the seed or the chips would be wiped by their own refresh.
    readProfiles.mockResolvedValue({ profiles: roster })
    $profiles.set(roster)
    $settingsScopeOverride.set('research')
  })
  afterEach(() => {
    localStorage.clear()
    $settingsScopeOverride.set(null)
    $profiles.set([])
  })

  it('reads and writes the scoped profile, not the active one', async () => {
    renderSection('settings')
    await screen.findByText(/gateway proxy/i)

    expect(readVars).toHaveBeenCalledWith('research')

    const input = screen.getByRole('textbox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'http://proxy' } })
    fireEvent.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(setVar).toHaveBeenCalledWith('GATEWAY_PROXY', 'http://proxy', 'research'))
  })

  it('renders one chip per profile and switches the target when one is picked', async () => {
    renderSection('settings')
    await screen.findByText(/gateway proxy/i)

    expect(screen.getByText('Applies to')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'default' }))

    // Picking the app's ACTIVE profile clears the override, so the next request
    // goes back to its unscoped shape rather than pinning "default".
    await waitFor(() => expect($settingsScopeOverride.get()).toBeNull())
    await waitFor(() => expect(readVars).toHaveBeenLastCalledWith(undefined))
  })
})
