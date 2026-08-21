/**
 * Live accent override.
 *
 * Authoring knob for `retintTheme`: while this holds a hex, the theme context
 * paints the active skin re-seeded from it. `null` means "off" — the theme
 * paints exactly as authored, which is the state the app boots in and returns
 * to, since nothing sets this unless a plugin does.
 *
 * Deliberately NOT persisted. It's a scratch control for finding a color you
 * like, and the outcome is meant to be written into `presets.ts` as a real
 * palette — not carried around as user state that would silently override a
 * theme the user picked later.
 */

import { atom } from '@/store/atom'

import { normalizeHex } from './color'

export const $accentOverride = atom<null | string>(null)

export function setAccentOverride(color: null | string): void {
  $accentOverride.set(color === null ? null : (normalizeHex(color) ?? $accentOverride.get()))
}
