interface SessionPruneResult {
  removed: number
  skipped_open: number
  /** Optional: gateways predating the keep-flag report omit it entirely. */
  skipped_pinned?: number
}

const plural = (n: number) => (n === 1 ? '' : 's')

export function formatSessionPruneResult(result: SessionPruneResult): string {
  const removed = `Pruned ${result.removed} session${plural(result.removed)}`
  const notes: string[] = []

  if (result.skipped_open) {
    notes.push(
      `Skipped ${result.skipped_open} open session${plural(result.skipped_open)}; prune only removes ended sessions.`
    )
  }

  // Pin is a durable keep flag, so the gateway spares pinned rows and reports
  // how many. Without this the toast just showed a lower count than the user
  // expected and left them guessing which rows survived.
  if (result.skipped_pinned) {
    notes.push(
      `Spared ${result.skipped_pinned} pinned session${plural(result.skipped_pinned)}; tick "Also prune pinned sessions" to delete those too.`
    )
  }

  return notes.length ? `${removed}. ${notes.join(' ')}` : removed
}
