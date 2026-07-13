import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: vi.fn(),
  getRecommendedDefaultModel: vi.fn(async () => ({ provider: 'openrouter', model: 'openrouter/auto', free_tier: null })),
  setEnvVar: vi.fn(async () => ({ ok: true })),
  setModelAssignment: vi.fn(async () => ({ ok: true, provider: 'openrouter', model: 'openrouter/auto', scope: 'main' })),
  validateProviderCredential: vi.fn(async () => ({ ok: true, reachable: true, message: '', models: ['local/model'] }))
}))

import { getGlobalModelOptions, setEnvVar, setModelAssignment, validateProviderCredential } from '@/hermes'

import { API_KEY_OPTIONS } from '@/app/onboarding/api-key-options'
import {
  $onboarding,
  $onboardingActive,
  $onboardingSeen,
  checkConfigured,
  confirmModel,
  saveApiKey
} from './onboarding'

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
    $onboarding.set({ step: 'picker', option: null, providerSlug: null, recommended: null, busy: false, error: null })
  })
  afterEach(() => localStorage.clear())

  it('marks seen (no wizard) when a provider is already configured', async () => {
    options.mockResolvedValueOnce({ providers: [{ name: 'OpenRouter', slug: 'openrouter', authenticated: true, models: ['a'] }] } as never)
    await checkConfigured()
    expect($onboardingActive.get()).toBe(false)
    expect($onboardingSeen.get()).toBe(true)
  })

  it('activates the wizard when nothing is configured', async () => {
    options.mockResolvedValueOnce({ providers: [{ name: 'OpenAI', slug: 'openai', authenticated: false, models: [] }] } as never)
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
    expect(assign).toHaveBeenCalledWith(expect.objectContaining({ scope: 'main', provider: 'openrouter', model: 'openrouter/auto' }))
    expect($onboardingSeen.get()).toBe(true)
    expect($onboardingActive.get()).toBe(false)
  })

  it('wires a local endpoint via validate + custom assignment', async () => {
    const ok = await saveApiKey(local, 'http://127.0.0.1:8000/v1', 'endpoint-key')
    expect(ok).toBe(true)
    expect(validate).toHaveBeenCalledWith('OPENAI_BASE_URL', 'http://127.0.0.1:8000/v1', 'endpoint-key')
    expect(assign).toHaveBeenCalledWith(expect.objectContaining({ provider: 'custom', base_url: 'http://127.0.0.1:8000/v1', model: 'local/model' }))
    expect($onboardingSeen.get()).toBe(true)
  })
})
