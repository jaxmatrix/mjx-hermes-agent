import { API_KEY_OPTIONS, type ApiKeyOption, LOCAL_ENV_KEY } from '@/app/onboarding/api-key-options'
import { getGlobalModelOptions, getRecommendedDefaultModel, setEnvVar, setModelAssignment, validateProviderCredential } from '@/hermes'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'
import type { RecommendedDefaultModel } from '@/hermes'

// First-run provider-setup wizard state. Adapted (leaned) from apps/desktop/src/
// store/onboarding.ts: the local-runtime boot/Preparing machinery is dropped
// (mobile is remote-only); provider OAuth lands in K11.b.

export type OnboardingStep = 'picker' | 'apikey' | 'confirm'

export interface OnboardingState {
  step: OnboardingStep
  option: ApiKeyOption | null
  providerSlug: string | null
  recommended: RecommendedDefaultModel | null
  busy: boolean
  error: string | null
}

const INITIAL: OnboardingState = { step: 'picker', option: null, providerSlug: null, recommended: null, busy: false, error: null }

// Persisted "user has been through (or dismissed) onboarding" flag — the mobile
// equivalent of desktop's hermes-desktop-onboarded / onboarding-skipped keys.
export const $onboardingSeen = persistentAtom<boolean>('hermes.mobile.onboarded', false, Codecs.bool)
export const $onboarding = atom<OnboardingState>(INITIAL)
export const $onboardingActive = atom(false)

const patch = (next: Partial<OnboardingState>) => $onboarding.set({ ...$onboarding.get(), ...next })

function finish() {
  $onboardingSeen.set(true)
  $onboardingActive.set(false)
  $onboarding.set(INITIAL)
}

/** Skip setup — remembered so we never re-nag. */
export function chooseLater() {
  finish()
}

/** Open the wizard manually (e.g. from Settings), regardless of the seen flag. */
export function openOnboarding() {
  $onboarding.set(INITIAL)
  $onboardingActive.set(true)
}

/** After connect: show the wizard only if no provider is configured (and unseen). */
export async function checkConfigured(): Promise<void> {
  if ($onboardingSeen.get()) {
    return
  }
  try {
    const { providers } = await getGlobalModelOptions()
    const configured = (providers ?? []).some(p => p.authenticated !== false && (p.models?.length ?? 0) > 0)
    if (configured) {
      $onboardingSeen.set(true)
      return
    }
    $onboarding.set(INITIAL)
    $onboardingActive.set(true)
  } catch {
    // A probe failure shouldn't force onboarding on top of a real connection.
  }
}

export function selectApiKeyProvider(option: ApiKeyOption) {
  patch({ step: 'apikey', option, error: null })
}

export function backToPicker() {
  patch({ step: 'picker', option: null, error: null })
}

/** Save a provider's API key (or wire a local endpoint), then advance. */
export async function saveApiKey(option: ApiKeyOption, value: string, localApiKey?: string): Promise<boolean> {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }
  patch({ busy: true, error: null })
  try {
    if (option.envKey === LOCAL_ENV_KEY) {
      const res = await validateProviderCredential(LOCAL_ENV_KEY, trimmed, localApiKey)
      if (!res.reachable || !res.models?.length) {
        patch({ busy: false, error: res.message || 'Endpoint unreachable' })
        return false
      }
      await setModelAssignment({ scope: 'main', provider: 'custom', base_url: trimmed, model: res.models[0], api_key: localApiKey })
      finish()
      return true
    }

    await setEnvVar(option.envKey, trimmed)
    const recommended = await getRecommendedDefaultModel(option.id).catch(() => null)
    patch({ busy: false, step: 'confirm', providerSlug: option.id, recommended })
    return true
  } catch (err) {
    patch({ busy: false, error: err instanceof Error ? err.message : 'Could not save credential.' })
    return false
  }
}

/** Confirm the recommended default model for the chosen provider, then done. */
export async function confirmModel(): Promise<boolean> {
  const { providerSlug, recommended } = $onboarding.get()
  if (!providerSlug) {
    return false
  }
  patch({ busy: true, error: null })
  try {
    if (recommended?.model) {
      await setModelAssignment({ scope: 'main', provider: recommended.provider || providerSlug, model: recommended.model })
    }
    finish()
    return true
  } catch (err) {
    patch({ busy: false, error: err instanceof Error ? err.message : 'Could not set the model.' })
    return false
  }
}

// Re-export for consumers that only need the curated list.
export { API_KEY_OPTIONS }
