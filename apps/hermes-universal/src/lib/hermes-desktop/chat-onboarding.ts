/**
 * `hermesDesktop.chatOnboarding` — grow / solo-boot the main window.
 *
 * Electron SoT: `chat-onboarding-window.ts` + `window-growth.ts`.
 * Rust: `chat_onboarding.rs` (`chat_onboarding_grow` / `chat_onboarding_solo_boot`).
 */

import { IS_DESKTOP } from '@/lib/platform'
import { readKey } from '@/lib/storage'

type Bridge = NonNullable<typeof window.hermesDesktop>
type ChatOnboarding = NonNullable<Bridge['chatOnboarding']>

async function invokeNative(command: string, args?: Record<string, unknown>): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')

  await invoke(command, args)
}

/** Same key as `zoom.ts` — grow requests arrive in CSS px; Rust converts with this factor. */
const ZOOM_KEY = 'hermes.zoomPercent'

function zoomFactor(): number {
  const raw = readKey(ZOOM_KEY)
  const percent = raw === null ? (IS_DESKTOP ? 90 : 100) : Number(raw)

  if (!Number.isFinite(percent) || percent <= 0) {
    return IS_DESKTOP ? 0.9 : 1
  }

  return Math.min(2, Math.max(0.5, percent / 100))
}

const grow: ChatOnboarding['grow'] = request => {
  void invokeNative('chat_onboarding_grow', {
    request: request ?? {},
    zoom: zoomFactor()
  }).catch(() => undefined)
}

const soloBoot: NonNullable<ChatOnboarding['soloBoot']> = () => {
  void invokeNative('chat_onboarding_solo_boot').catch(() => undefined)
}

export const chatOnboardingBridge: Pick<Bridge, 'chatOnboarding'> | Record<string, never> = IS_DESKTOP
  ? {
      chatOnboarding: { grow, soloBoot }
    }
  : {}
