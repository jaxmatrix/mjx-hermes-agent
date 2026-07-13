import { impactFeedback, notificationFeedback } from '@tauri-apps/plugin-haptics'

import { Codecs, persistentAtom } from '@/lib/persisted'

// Haptics seam (Gc10/R9). Maps intents to the native plugin, with a Web
// Vibration fallback and a persisted mute toggle. Guarded so a non-Tauri context
// (browser dev / vitest) never throws.
export type HapticIntent = 'select' | 'submit' | 'success' | 'warning'

export const $hapticsMuted = persistentAtom<boolean>('hermes.hapticsMuted', false, Codecs.bool)

export async function triggerHaptic(intent: HapticIntent): Promise<void> {
  if ($hapticsMuted.get()) return
  try {
    if (intent === 'success') await notificationFeedback('success')
    else if (intent === 'warning') await notificationFeedback('warning')
    else await impactFeedback('light')
  } catch {
    try {
      navigator.vibrate?.(intent === 'warning' ? 40 : 10)
    } catch {
      /* Vibration API unsupported */
    }
  }
}
