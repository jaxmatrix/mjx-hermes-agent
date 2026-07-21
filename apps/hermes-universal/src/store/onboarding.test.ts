import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: vi.fn(),
  getRecommendedDefaultModel: vi.fn(async () => ({
    provider: 'openrouter',
    model: 'openrouter/auto',
    free_tier: null
  })),
  setEnvVar: vi.fn(async () => ({ ok: true })),
  setModelAssignment: vi.fn(async () => ({
    ok: true,
    provider: 'openrouter',
    model: 'openrouter/auto',
    scope: 'main'
  })),
  validateProviderCredential: vi.fn(async () => ({ ok: true, reachable: true, message: '', models: ['local/model'] })),
  listOAuthProviders: vi.fn(async () => ({ providers: [] })),
  startOAuthLogin: vi.fn(),
  pollOAuthSession: vi.fn(async () => ({ session_id: 's', status: 'pending' })),
  submitOAuthCode: vi.fn(async () => ({ ok: true, status: 'approved' })),
  cancelOAuthSession: vi.fn(async () => ({ ok: true }))
}))

// openExternalLink is fired during OAuth start; stub it (no Tauri host in tests).
vi.mock('@/lib/external-link', () => ({ openExternalLink: vi.fn(async () => {}) }))

import { API_KEY_OPTIONS } from '@/app/onboarding/api-key-options'
import {
  getGlobalModelOptions,
  setEnvVar,
  setModelAssignment,
  startOAuthLogin,
  validateProviderCredential
} from '@/hermes'
import type { OAuthProvider } from '@/types/hermes'

import {
  $onboarding,
  $onboardingActive,
  $onboardingSeen,
  backToPicker,
  checkConfigured,
  confirmModel,
  saveApiKey,
  startProviderOAuth,
  submitOnboardingCode
} from './onboarding'

const oauthProvider = (flow: 'device_code' | 'pkce'): OAuthProvider =>
  ({
    id: 'anthropic',
    name: 'Anthropic',
    flow,
    cli_command: '',
    docs_url: '',
    status: { logged_in: false }
  }) as OAuthProvider

const startLogin = vi.mocked(startOAuthLogin)

const options = vi.mocked(getGlobalModelOptions)
const setEnv = vi.mocked(setEnvVar)
const assign = vi.mocked(setModelAssignment)
const validate = vi.mocked(validateProviderCredential)

const openrouter = API_KEY_OPTIONS.find(o => o.id === 'openrouter')!
const local = API_KEY_OPTIONS.find(o => o.id === 'local')!

describe('onboarding store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    $onboardingSeen.set(false)
    $onboardingActive.set(false)
    $onboarding.set({
      step: 'picker',
      option: null,
      providerSlug: null,
      recommended: null,
      oauth: null,
      busy: false,
      error: null
    })
  })
  afterEach(() => localStorage.clear())

  it('marks seen (no wizard) when a provider is already configured', async () => {
    options.mockResolvedValueOnce({
      providers: [{ name: 'OpenRouter', slug: 'openrouter', authenticated: true, models: ['a'] }]
    } as never)
    await checkConfigured()
    expect($onboardingActive.get()).toBe(false)
    expect($onboardingSeen.get()).toBe(true)
  })

  it('activates the wizard when nothing is configured', async () => {
    options.mockResolvedValueOnce({
      providers: [{ name: 'OpenAI', slug: 'openai', authenticated: false, models: [] }]
    } as never)
    await checkConfigured()
    expect($onboardingActive.get()).toBe(true)
  })

  it('saves an API key then advances to the confirm step', async () => {
    const ok = await saveApiKey(openrouter, 'sk-test')
    expect(ok).toBe(true)
    expect(setEnv).toHaveBeenCalledWith('OPENROUTER_API_KEY', 'sk-test')
    expect($onboarding.get().step).toBe('confirm')
    expect($onboarding.get().providerSlug).toBe('openrouter')
  })

  it('confirms the recommended model and finishes', async () => {
    await saveApiKey(openrouter, 'sk-test')
    const ok = await confirmModel()
    expect(ok).toBe(true)
    expect(assign).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'main', provider: 'openrouter', model: 'openrouter/auto' })
    )
    expect($onboardingSeen.get()).toBe(true)
    expect($onboardingActive.get()).toBe(false)
  })

  it('wires a local endpoint via validate + custom assignment', async () => {
    const ok = await saveApiKey(local, 'http://127.0.0.1:8000/v1', 'endpoint-key')
    expect(ok).toBe(true)
    expect(validate).toHaveBeenCalledWith('OPENAI_BASE_URL', 'http://127.0.0.1:8000/v1', 'endpoint-key')
    expect(assign).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'custom', base_url: 'http://127.0.0.1:8000/v1', model: 'local/model' })
    )
    expect($onboardingSeen.get()).toBe(true)
  })

  it('enters the OAuth step for a device_code provider', async () => {
    startLogin.mockResolvedValueOnce({
      flow: 'device_code',
      session_id: 'sess',
      verification_url: 'https://v',
      user_code: 'ABCD',
      expires_in: 600,
      poll_interval: 5
    } as never)
    await startProviderOAuth(oauthProvider('device_code'))
    const oauth = $onboarding.get().oauth
    expect($onboarding.get().step).toBe('oauth')
    expect(oauth?.flow).toBe('device_code')
    expect(oauth?.userCode).toBe('ABCD')
    backToPicker() // stop the poll timer
  })

  it('completes a PKCE flow: submit code → confirm step', async () => {
    startLogin.mockResolvedValueOnce({
      flow: 'pkce',
      session_id: 'sess',
      auth_url: 'https://a',
      expires_in: 600
    } as never)
    await startProviderOAuth(oauthProvider('pkce'))
    expect($onboarding.get().oauth?.flow).toBe('pkce')

    const ok = await submitOnboardingCode('the-code')
    expect(ok).toBe(true)
    expect($onboarding.get().step).toBe('confirm')
    expect($onboarding.get().providerSlug).toBe('anthropic')
  })
})
