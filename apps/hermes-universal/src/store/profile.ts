// Compat shim: ported desktop code imports `@/store/profile` (singular) for the
// gateway-scoped profile key. Universal's profile state lives in `@/store/profiles`
// (plural, leaner). We expose the two symbols the ported Capabilities code needs,
// backed by universal's `$activeProfile`, so the desktop imports resolve verbatim.
import { getProfiles } from '@/hermes'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { computed } from '@/store/atom'
import { $activeProfile, $profiles, setActiveProfile as setUniversalActiveProfile } from '@/store/profiles'
import type { ProfileInfo } from '@/types/hermes'

// Canonical key for a profile: trimmed, empty/null → "default". Verbatim from
// desktop store/profile.ts — used to key profile-scoped caches (analytics badges).
export function normalizeProfileKey(name: string | null | undefined): string {
  const value = (name ?? '').trim()

  return value || 'default'
}

// Desktop's `$activeGatewayProfile` is an atom<string> that names the profile the
// live backend is scoped to ('default' = root). Universal's `$activeProfile` is a
// nullable persisted atom (null = primary), so we derive the normalized key.
export const $activeGatewayProfile = computed($activeProfile, profile => normalizeProfileKey(profile))

// Desktop's unified "All profiles" browse mode (`$showAllProfiles`) has no
// universal equivalent yet, so the scope always follows the live gateway
// profile. ALL_PROFILES is still exported because ported views compare against
// it — they simply never see it here.
export const ALL_PROFILES = '__all__'

export const $profileScope = $activeGatewayProfile

// ── Rail colors ────────────────────────────────────────────────────────────
// Verbatim from desktop store/profile.ts, on universal's `persistentAtom` seam.
// Optional per-profile color override; absent names fall back to the
// deterministic hue from profileColor() in `@/lib/profile-color`.
export const $profileColors = persistentAtom<Record<string, string>>('hermes.profileColors', {}, Codecs.stringRecord)

/** Set (or, with null, clear) a profile's color override. */
export function setProfileColor(name: string, color: null | string): void {
  const key = normalizeProfileKey(name)
  const next = { ...$profileColors.get() }

  if (color) {
    next[key] = color
  } else {
    delete next[key]
  }

  $profileColors.set(next)
}

/** Desktop's signature — pull the profile list and return it (universal's
 *  `@/store/profiles` refreshProfiles() returns void and swallows errors, which
 *  the ported Profiles view needs to surface). */
export async function refreshProfiles(): Promise<ProfileInfo[]> {
  const { profiles } = await getProfiles()
  $profiles.set(profiles)

  return profiles
}

/** Desktop swaps the live gateway onto the profile's backend; universal re-scopes
 *  its REST calls and refetches instead (see `@/store/profiles`). Both land on
 *  "the app now operates as this profile", so the two desktop entry points map
 *  onto the one universal switch. */
export function selectProfile(name: string): void {
  setUniversalActiveProfile(normalizeProfileKey(name) === 'default' ? null : name)
}

export const setActiveProfile = selectProfile
