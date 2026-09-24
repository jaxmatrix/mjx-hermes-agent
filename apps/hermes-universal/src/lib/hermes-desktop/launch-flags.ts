/**
 * Electron launch-time booleans on `hermesDesktop`.
 *
 * Electron stamps these from argv/env once at preload. Callers read them
 * synchronously (`window.hermesDesktop.localModelsEnabled === true`), so they
 * cannot be async `get_app_flag` IPC. Universal mirrors the defaults: local
 * models on every desktop OS (phones stay off), guest onboarding and skip-intro
 * off until a native argv/env path lands.
 */

import { IS_DESKTOP } from '@/lib/platform'

type Bridge = NonNullable<typeof window.hermesDesktop>

export const launchFlagsBridge: Pick<Bridge, 'localModelsEnabled' | 'guestOnboardingEnabled' | 'skipIntro'> = {
  // Electron: `--local` OR win32 OR darwin. Universal enables local models on
  // every desktop host — the settings / tips surfaces already gate on this.
  localModelsEnabled: IS_DESKTOP,
  guestOnboardingEnabled: false,
  skipIntro: false
}
