// Universal adapter for the ported composer. Desktop's chat-runtime.ts is a
// 400-line runtime pipeline pulling in desktop-app-shell types (@/app/types)
// the universal app doesn't have. The composer only needs these three
// self-contained helpers, reproduced verbatim from desktop.

import type { SessionInfo } from '@/types/hermes'

/** Matches a leading slash command token (`/foo` or `/foo `) at the start of a draft. */
export const SLASH_COMMAND_RE = /^\/[^\s/]*(?:\s|$)/

/** Human-readable session title: title → preview → fallback. */
export function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.preview?.trim() || 'Untitled session'
}

/** Display a path relative to cwd (strip the cwd prefix when present). */
export function contextPath(path: string, cwd: string): string {
  if (!cwd) {
    return path
  }

  const normalizedCwd = cwd.endsWith('/') ? cwd : `${cwd}/`

  return path.startsWith(normalizedCwd) ? path.slice(normalizedCwd.length) : path
}
