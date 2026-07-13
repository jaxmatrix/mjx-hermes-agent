import { platform } from '@tauri-apps/plugin-os'

// Platform gating (A6). `platform()` (from tauri-plugin-os) is synchronous in v2
// but reads a value injected by the Tauri runtime at startup, so it THROWS when
// there is no runtime — plain-browser `vite dev`, or vitest/jsdom. Guard it and
// fall back to 'unknown', which yields desktop-like defaults (the right choice
// for desktop dev and harmless in tests).
function detectPlatform(): string {
  try {
    return platform()
  } catch {
    return 'unknown'
  }
}

export const PLATFORM = detectPlatform()
export const IS_ANDROID = PLATFORM === 'android'
export const IS_IOS = PLATFORM === 'ios'
export const IS_MOBILE = IS_ANDROID || IS_IOS

// Local-spawn gateway mode is a desktop-only capability: Tauri also builds
// desktop targets, where a bundled backend could run, but a phone can't spawn
// one. Mobile-only UIs (E2 mode picker, terminal, updater, pet-overlay) branch
// on this to stay hidden on Android/iOS.
export const LOCAL_MODE_SUPPORTED = !IS_MOBILE
