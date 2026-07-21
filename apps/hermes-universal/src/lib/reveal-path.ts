import { IS_TAURI } from '@/lib/platform'

// Reveal a filesystem path in the OS file manager (Finder/Explorer/Files) via
// the native `reveal_in_file_manager` command. No-op off Tauri (plain-web dev /
// vitest). Callers should only surface this on desktop with a local backend —
// the path must exist on THIS machine's disk (a remote backend's cwd doesn't).
export async function revealPathInFileManager(path: string): Promise<void> {
  if (!IS_TAURI) {
    return
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('reveal_in_file_manager', { path })
  } catch {
    /* native command unavailable — nothing to do */
  }
}
