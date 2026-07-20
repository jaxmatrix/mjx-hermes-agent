// Compat shim: ported desktop code imports `@/store/profile` (singular) for the
// gateway-scoped profile key. Universal's profile state lives in `@/store/profiles`
// (plural, leaner). We expose the two symbols the ported Capabilities code needs,
// backed by universal's `$activeProfile`, so the desktop imports resolve verbatim.
import { computed } from '@/store/atom'
import { $activeProfile } from '@/store/profiles'

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
