import { getMessagingPlatforms, testMessagingPlatform, updateMessagingPlatform } from '@/hermes'
import { atom } from '@/store/atom'
import { notifyError } from '@/store/notifications'
import type { MessagingPlatformInfo, MessagingPlatformTestResponse } from '@/types/hermes'

// Messaging platforms store. Auth is token/env entry (no OAuth). Saving env
// needs a gateway restart to take effect — we surface that as a hint rather than
// auto-restarting, since a remote restart would drop this client's own
// connection (unlike desktop's local gateway).
export const $platforms = atom<MessagingPlatformInfo[]>([])
export const $messagingLoading = atom(false)
export const $messagingError = atom<string | null>(null)

export async function refreshMessaging(): Promise<void> {
  $messagingLoading.set(true)
  $messagingError.set(null)
  try {
    $platforms.set((await getMessagingPlatforms()).platforms)
  } catch (err) {
    $messagingError.set(err instanceof Error ? err.message : 'Failed to load messaging platforms')
  } finally {
    $messagingLoading.set(false)
  }
}

function patch(id: string, next: Partial<MessagingPlatformInfo>) {
  $platforms.set($platforms.get().map(p => (p.id === id ? { ...p, ...next } : p)))
}

export async function setPlatformEnabled(id: string, enabled: boolean): Promise<void> {
  const prev = $platforms.get()
  patch(id, { enabled })
  try {
    await updateMessagingPlatform(id, { enabled })
  } catch (err) {
    $platforms.set(prev)
    notifyError(err, 'Failed to update platform')
  }
}

/** Persist credential env for a platform. Returns success. */
export async function savePlatformEnv(id: string, env: Record<string, string>): Promise<boolean> {
  try {
    await updateMessagingPlatform(id, { env })
    await refreshMessaging()
    return true
  } catch (err) {
    notifyError(err, 'Failed to save platform')
    return false
  }
}

export function testPlatform(id: string): Promise<MessagingPlatformTestResponse> {
  return testMessagingPlatform(id)
}
