/**
 * Host-only cwd aliases for universal call sites that still name the
 * pre-absorb `$effectiveCwd` / `$workspaceCwd` pair.
 *
 * Desktop folds both into `$currentCwd` (session) plus `$focusedCwd`
 * (session-key-states). Do NOT put these back on AUTO `workspace-events.ts`.
 */
import { computed } from 'nanostores'

import { $currentCwd, setCurrentCwd } from '@/store/session'
import { $focusedCwd } from '@/store/session-key-states'

/** Remembered / selected workspace root — same atom desktop uses. */
export const $workspaceCwd = $currentCwd

/** Focused chat cwd when set; otherwise the workspace root. */
export const $effectiveCwd = computed([$focusedCwd, $currentCwd], (focused, current) => {
  const trimmed = focused.trim()

  return trimmed || current
})

export function setWorkspaceCwd(path: string): void {
  setCurrentCwd(path)
}
