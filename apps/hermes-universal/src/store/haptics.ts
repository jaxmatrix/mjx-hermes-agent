import { Codecs, persistentAtom } from '@/lib/persisted'

// Haptics mute state. Mirrors desktop's `store/haptics.ts`, which holds only
// this — the intent vocabulary, pattern table, and rate limiting all live in
// `@/lib/haptics` (a byte-identical copy of desktop's), and the platform backend
// is registered by `components/haptics-provider.tsx`.
//
// This module used to ALSO export a `triggerHaptic` that called the Tauri plugin
// directly. It was removed: two competing haptics APIs meant every ported desktop
// file needed its import rewritten, and the desktop-verbatim one was dead code
// (nothing registered a trigger for it). Import `triggerHaptic` from
// `@/lib/haptics` — that is now the only one.
//
// Storage key deliberately differs from desktop's `hermes.desktop.hapticsMuted`:
// universal already shipped `hermes.hapticsMuted`, and renaming it would silently
// reset every existing user's mute preference.
export const $hapticsMuted = persistentAtom<boolean>('hermes.hapticsMuted', false, Codecs.bool)

export function setHapticsMuted(muted: boolean) {
  $hapticsMuted.set(muted)
}

export function toggleHapticsMuted() {
  $hapticsMuted.set(!$hapticsMuted.get())
}
