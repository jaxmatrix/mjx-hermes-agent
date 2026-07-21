// Display helpers for workspace / session working directories.

/**
 * The label for a working directory: its leaf folder name (ported from desktop's
 * use-statusbar-items `workspaceLabel`). Falls back to the whole path when there
 * is no leaf to take — e.g. a filesystem root — and to '' when there's no cwd.
 */
export function workspaceLabel(cwd?: null | string): string {
  if (!cwd) {
    return ''
  }

  const normalized = cwd.replace(/[\\/]+$/, '')
  const leaf = normalized.split(/[\\/]/).filter(Boolean).pop()

  return leaf || cwd
}
