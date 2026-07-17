// STUB — desktop's review store drives the diff/review pane (git worktree diff
// viewer) opened from the CodingStatusRow. That row is a no-op stub in universal
// (no branch/worktree RPCs yet), so toggleReview is a no-op kept only so the
// ported composer's import + handler wiring compiles. FLAG(chat-port).

export function toggleReview(): void {
  /* no-op: review pane not ported */
}
