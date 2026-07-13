import { createProfile, deleteProfile, getProfiles, renameProfile } from '@/hermes'
import { atom } from '@/store/atom'
import { notifyError } from '@/store/notifications'
import type { ProfileCreatePayload, ProfileInfo } from '@/types/hermes'

// Profiles store (view/CRUD only). App-wide profile *switching* is a desktop
// spawn/pool concern that doesn't apply to mobile's single remote gateway —
// FIXME(E): re-scope the one connection when multi-profile lands.
export const $profiles = atom<ProfileInfo[]>([])
export const $profilesLoading = atom(false)
export const $profilesError = atom<string | null>(null)

export async function refreshProfiles(): Promise<void> {
  $profilesLoading.set(true)
  $profilesError.set(null)
  try {
    $profiles.set((await getProfiles()).profiles)
  } catch (err) {
    $profilesError.set(err instanceof Error ? err.message : 'Failed to load profiles')
  } finally {
    $profilesLoading.set(false)
  }
}

export async function createProfileLocal(payload: ProfileCreatePayload): Promise<boolean> {
  try {
    await createProfile(payload)
    await refreshProfiles()
    return true
  } catch (err) {
    notifyError(err, 'Failed to create profile')
    return false
  }
}

export async function renameProfileLocal(name: string, newName: string): Promise<boolean> {
  try {
    await renameProfile(name, newName)
    await refreshProfiles()
    return true
  } catch (err) {
    notifyError(err, 'Failed to rename profile')
    return false
  }
}

export async function removeProfile(name: string): Promise<void> {
  const prev = $profiles.get()
  $profiles.set(prev.filter(p => p.name !== name))
  try {
    await deleteProfile(name)
  } catch (err) {
    $profiles.set(prev)
    notifyError(err, 'Failed to delete profile')
  }
}

// Profile name rules (mirrors the desktop nameHint copy).
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name.trim())
}
