import { type ReactNode, useEffect } from 'react'
import { useWebHaptics } from 'web-haptics/react'

import { registerHapticTrigger } from '@/lib/haptics'
import { tauriHapticTrigger } from '@/lib/haptics-tauri'
import { IS_DESKTOP, IS_MOBILE } from '@/lib/platform'
import { useStore } from '@/store/atom'
import { $hapticsMuted } from '@/store/haptics'

// Registers a platform backend for the `@/lib/haptics` seam. Ported from
// apps/desktop/src/components/haptics-provider.tsx; the difference is that
// universal has to pick a backend at runtime, because it ships desktop AND mobile
// from one codebase:
//
//   desktop (Tauri macOS/Windows/Linux) → web-haptics, same as hermes-desktop
//   mobile  (Tauri Android/iOS)         → @tauri-apps/plugin-haptics renderer
//   neither (plain-browser dev, vitest) → nothing registered
//
// The third case matters: `platform()` throws without a Tauri runtime, so
// lib/platform resolves PLATFORM to 'unknown' and both flags are false. With no
// trigger registered, triggerHaptic() no-ops — which is what the test suite
// already assumes.
//
// The Tauri haptics plugin is mobile-only (it no-ops on desktop targets), which
// is why desktop needs web-haptics rather than just using the plugin everywhere.
export function HapticsProvider({ children }: { children: ReactNode }) {
  const muted = useStore($hapticsMuted)
  // Called unconditionally — hooks can't be behind a platform branch. On mobile
  // its trigger is simply never registered.
  const { trigger: webTrigger } = useWebHaptics({ debug: false, showSwitch: false })

  useEffect(() => {
    if (muted) {
      registerHapticTrigger(null)

      return () => registerHapticTrigger(null)
    }

    if (IS_MOBILE) {
      registerHapticTrigger(tauriHapticTrigger)
    } else if (IS_DESKTOP) {
      registerHapticTrigger(webTrigger)
    }

    return () => registerHapticTrigger(null)
  }, [muted, webTrigger])

  // web-haptics builds its AudioContext lazily inside the first trigger(), and
  // the process's first AudioContext pays the CoreAudio spin-up (~850ms stall in
  // desktop's profiles) — which landed on the first streamStart haptic as the
  // first token painted. Open/close a throwaway context at idle so the real one
  // connects to an already-warm audio service in single-digit ms.
  //
  // Desktop-only: the mobile backend never touches AudioContext, and spinning one
  // up on a phone is pure battery cost.
  useEffect(() => {
    if (!IS_DESKTOP || typeof requestIdleCallback !== 'function' || typeof AudioContext === 'undefined') {
      return undefined
    }

    const id = requestIdleCallback(
      () => {
        try {
          void new AudioContext().close().catch(() => undefined)
        } catch {
          // No audio device (headless CI) — nothing to warm.
        }
      },
      { timeout: 2000 }
    )

    return () => cancelIdleCallback(id)
  }, [])

  return <>{children}</>
}
