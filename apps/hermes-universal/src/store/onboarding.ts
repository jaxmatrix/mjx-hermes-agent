import { API_KEY_OPTIONS, type ApiKeyOption, LOCAL_ENV_KEY } from '@/app/onboarding/api-key-options'
import {
  cancelOAuthSession,
  getGlobalModelOptions,
  getRecommendedDefaultModel,
  pollOAuthSession,
  setEnvVar,
  setModelAssignment,
  startOAuthLogin,
  submitOAuthCode,
  validateProviderCredential
} from '@/hermes'
import { openExternalLink } from '@/lib/external-link'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'
import type { RecommendedDefaultModel } from '@/hermes'
import type { OAuthProvider } from '@/types/hermes'

// First-run provider-setup wizard state. Adapted (leaned) from apps/desktop/src/
// store/onboarding.ts: the local-runtime boot/Preparing machinery is dropped
// (mobile is remote-only).

export type OnboardingStep = 'picker' | 'apikey' | 'oauth' | 'confirm'

// Provider OAuth sub-flow. device_code → poll until approved; pkce → the user
// pastes an authorization code back. `external` (CLI) providers are excluded.
export interface OAuthFlowState {
  provider: OAuthProvider
  sessionId: string
  flow: 'device_code' | 'pkce'
  url: string
  userCode?: string
  status: 'pending' | 'awaiting_code' | 'submitting' | 'error'
}

export interface OnboardingState {
  step: OnboardingStep
  option: ApiKeyOption | null
  providerSlug: string | null
  recommended: RecommendedDefaultModel | null
  oauth: OAuthFlowState | null
  busy: boolean
  error: string | null
}

const INITIAL: OnboardingState = { step: 'picker', option: null, providerSlug: null, recommended: null, oauth: null, busy: false, error: null }

// Persisted "user has been through (or dismissed) onboarding" flag — the mobile
// equivalent of desktop's hermes-desktop-onboarded / onboarding-skipped keys.
export const $onboardingSeen = persistentAtom<boolean>('hermes.mobile.onboarded', false, Codecs.bool)
export const $onboarding = atom<OnboardingState>(INITIAL)
export const $onboardingActive = atom(false)

const patch = (next: Partial<OnboardingState>) => $onboarding.set({ ...$onboarding.get(), ...next })

// ── Provider OAuth polling (device_code) ────────────────────────────────────
let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollSession: string | null = null

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
  }
  pollTimer = null
  pollSession = null
}

async function onProviderConnected(provider: OAuthProvider) {
  stopPolling()
  const recommended = await getRecommendedDefaultModel(provider.id).catch(() => null)
  patch({ step: 'confirm', providerSlug: provider.id, recommended, oauth: null, busy: false, error: null })
}

function pollDeviceCode(provider: OAuthProvider, sessionId: string, intervalMs: number) {
  pollSession = sessionId
  const tick = async () => {
    if (pollSession !== sessionId) {
      return
    }
    try {
      const res = await pollOAuthSession(provider.id, sessionId)
      if (pollSession !== sessionId) {
        return
      }
      if (res.status === 'approved') {
        void onProviderConnected(provider)
      } else if (res.status === 'pending') {
        pollTimer = setTimeout(() => void tick(), intervalMs)
      } else {
        stopPolling()
        setOAuth({ status: 'error' })
        patch({ error: res.error_message || 'Sign-in failed. Try again.' })
      }
    } catch {
      // Transient poll error — keep waiting.
      pollTimer = setTimeout(() => void tick(), intervalMs)
    }
  }
  pollTimer = setTimeout(() => void tick(), intervalMs)
}

const setOAuth = (next: Partial<OAuthFlowState>) => {
  const oauth = $onboarding.get().oauth
  if (oauth) {
    patch({ oauth: { ...oauth, ...next } })
  }
}

function finish() {
  stopPolling()
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
  const oauth = $onboarding.get().oauth
  stopPolling()
  if (oauth) {
    void cancelOAuthSession(oauth.sessionId).catch(() => {})
  }
  patch({ step: 'picker', option: null, oauth: null, error: null })
}

/** Begin a provider OAuth sign-in: start the session, open the browser, then
 *  either poll (device_code) or await a pasted code (pkce). */
export async function startProviderOAuth(provider: OAuthProvider): Promise<void> {
  patch({ busy: true, error: null })
  try {
    const start = await startOAuthLogin(provider.id)
    void openExternalLink(start.flow === 'pkce' ? start.auth_url : start.verification_url)
    if (start.flow === 'device_code') {
      patch({
        busy: false,
        step: 'oauth',
        oauth: { provider, sessionId: start.session_id, flow: 'device_code', url: start.verification_url, userCode: start.user_code, status: 'pending' }
      })
      pollDeviceCode(provider, start.session_id, Math.max(1, start.poll_interval || 3) * 1000)
    } else {
      patch({
        busy: false,
        step: 'oauth',
        oauth: { provider, sessionId: start.session_id, flow: 'pkce', url: start.auth_url, status: 'awaiting_code' }
      })
    }
  } catch (err) {
    patch({ busy: false, error: err instanceof Error ? err.message : 'Sign-in failed. Try again.' })
  }
}

/** Submit a PKCE authorization code the user pasted from the browser. */
export async function submitOnboardingCode(code: string): Promise<boolean> {
  const oauth = $onboarding.get().oauth
  if (!oauth || !code.trim()) {
    return false
  }
  setOAuth({ status: 'submitting' })
  patch({ busy: true, error: null })
  try {
    const res = await submitOAuthCode(oauth.provider.id, oauth.sessionId, code.trim())
    if (res.ok && res.status === 'approved') {
      await onProviderConnected(oauth.provider)
      return true
    }
    setOAuth({ status: 'awaiting_code' })
    patch({ busy: false, error: res.message || 'Sign-in failed. Try again.' })
    return false
  } catch (err) {
    setOAuth({ status: 'awaiting_code' })
    patch({ busy: false, error: err instanceof Error ? err.message : 'Sign-in failed. Try again.' })
    return false
  }
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
