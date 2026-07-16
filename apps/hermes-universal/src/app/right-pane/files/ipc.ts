import { readDir } from '@/hermes'
import type { ReadDirResult } from '@/types/hermes'

// The tree's directory reader. Adapted from desktop's files/ipc.ts: on desktop it
// bridged local Electron FS + client-side .gitignore; here it's the remote REST
// `readDir` (`/api/fs/list`) — the backend owns path hardening, and we just strip
// a small set of always-noise entries. (gitignore-aware filtering is deferred.)

const ALWAYS_EXCLUDED = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '__pycache__',
  '.venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache'
])

export async function readProjectDir(dirPath: string): Promise<ReadDirResult> {
  const res = await readDir(dirPath)
  if (res.error) return res
  return { entries: res.entries.filter(entry => !ALWAYS_EXCLUDED.has(entry.name)) }
}

// Kept for API parity with the desktop hook's cache-invalidation calls. This
// reader doesn't cache (readDir is a cheap REST hit), so these are no-ops.
export function clearProjectDirCache(_path?: string): void {
  /* no cache to clear */
}
