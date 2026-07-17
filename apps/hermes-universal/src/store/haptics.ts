import { impactFeedback, notificationFeedback } from '@tauri-apps/plugin-haptics'

import { Codecs, persistentAtom } from '@/lib/persisted'

// Haptics seam (Gc10/R9). Maps intents to the native plugin, with a Web
// Vibration fallback and a persisted mute toggle. Guarded so a non-Tauri context
// (browser dev / vitest) never throws.
// Superset of intents used across the app + the ported desktop composer
// ('selection'/'cancel'/'open'/'close' come from desktop's @/lib/haptics).
export type HapticIntent =
  | 'cancel'
  | 'close'
  | 'open'
  | 'select'
  | 'selection'
  | 'submit'
  | 'success'
  | 'warning'

export const $hapticsMuted = persistentAtom<boolean>('hermes.hapticsMuted', false, Codecs.bool)

export async function triggerHaptic(intent: HapticIntent): Promise<void> {
  if ($hapticsMuted.get()) return
  try {
    if (intent === 'success') await notificationFeedback('success')
    else if (intent === 'warning' || intent === 'cancel') await notificationFeedback('warning')
    else await impactFeedback('light')
  } catch {
    try {
      navigator.vibrate?.(intent === 'warning' || intent === 'cancel' ? 40 : 10)
    } catch {
      /* Vibration API unsupported */
    }
  }
}
