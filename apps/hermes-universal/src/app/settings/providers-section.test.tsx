import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvVarInfo, OAuthProvider } from '@/types/hermes'

const oauthProvider = (over: Partial<OAuthProvider> & Pick<OAuthProvider, 'id'>): OAuthProvider => ({
  cli_command: '',
  docs_url: '',
  flow: 'pkce',
  name: over.id,
  status: { logged_in: false },
  ...over
})

const envVar = (over: Partial<EnvVarInfo>): EnvVarInfo => ({
  advanced: false,
  category: 'provider',
  description: '',
  is_password: true,
  is_set: false,
  redacted_value: null,
  tools: [],
  url: null,
  ...over
})

vi.mock('@/hermes', () => ({
  listOAuthProviders: vi.fn(async () => ({ providers: [] as OAuthProvider[] })),
  disconnectOAuthProvider: vi.fn(async () => ({ ok: true, provider: 'x' })),
  getEnvVars: vi.fn(async () => ({}) as Record<string, EnvVarInfo>),
  setEnvVar: vi.fn(async () => ({ ok: true })),
  deleteEnvVar: vi.fn(async () => ({ ok: true })),
  revealEnvVar: vi.fn(async (key: string) => ({ key, value: 'secret-value' }))
}))

vi.mock('@/store/onboarding', () => ({
  $connectProvider: atom<unknown>(null),
  beginProviderConnect: vi.fn()
}))

import { disconnectOAuthProvider, getEnvVars, listOAuthProviders } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { beginProviderConnect } from '@/store/onboarding'

import { ProvidersSection } from './providers-section'

const providers = vi.mocked(listOAuthProviders)
const envVars = vi.mocked(getEnvVars)

function renderProviders(view: 'accounts' | 'keys') {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[`/settings/providers${view === 'keys' ? '/keys' : ''}`]}>
        <ProvidersSection view={view} />
      </MemoryRouter>
    </I18nProvider>
  )
}

describe('ProvidersSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providers.mockResolvedValue({ providers: [] })
    envVars.mockResolvedValue({})
  })
  afterEach(() => vi.restoreAllMocks())

  it('accounts view: lists connected + featured providers and hands off connect', async () => {
    providers.mockResolvedValue({
      providers: [
        oauthProvider({ id: 'nous', name: 'Nous', flow: 'device_code' }),
        oauthProvider({ id: 'openai-codex', name: 'OpenAI', status: { logged_in: true }, disconnectable: true })
      ]
    })

    renderProviders('accounts')

    // Featured (not-logged-in Nous) + connected (openai-codex) both render.
    const featured = await screen.findByRole('button', { name: /Nous Portal/ })
    expect(screen.getByText('OpenAI OAuth (ChatGPT)')).toBeInTheDocument()
    // Connected provider has a disconnect control.
    expect(screen.getByRole('button', { name: /Remove OpenAI OAuth/ })).toBeInTheDocument()

    // Clicking the featured row hands off to the onboarding OAuth flow.
    fireEvent.click(featured)
    expect(vi.mocked(beginProviderConnect)).toHaveBeenCalledWith(expect.objectContaining({ id: 'nous' }))
  })

  it('accounts view: disconnect calls the RPC after confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    providers.mockResolvedValue({
      providers: [
        oauthProvider({ id: 'openai-codex', name: 'OpenAI', status: { logged_in: true }, disconnectable: true })
      ]
    })

    renderProviders('accounts')
    fireEvent.click(await screen.findByRole('button', { name: /Remove OpenAI OAuth/ }))

    await waitFor(() => expect(vi.mocked(disconnectOAuthProvider)).toHaveBeenCalledWith('openai-codex'))
  })

  it('api keys view: renders a provider-grouped credential card', async () => {
    envVars.mockResolvedValue({
      ANTHROPIC_API_KEY: envVar({
        provider: 'anthropic',
        provider_label: 'Anthropic',
        is_set: true,
        redacted_value: 'sk-…abcd'
      })
    })

    renderProviders('keys')

    expect(await screen.findByText('Anthropic')).toBeInTheDocument()
  })
})
