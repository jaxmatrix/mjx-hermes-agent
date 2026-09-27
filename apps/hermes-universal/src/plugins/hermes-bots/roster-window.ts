/**
 * Client-side windowing for the bots roster — full list is already in memory;
 * we only mount the first N rows and grow near the bottom (pet gallery pattern).
 */

export const ROSTER_WINDOW_INITIAL = 40
export const ROSTER_WINDOW_STEP = 24

export function nextRosterWindow(current: number, total: number, step = ROSTER_WINDOW_STEP): number {
  return Math.min(current + step, Math.max(total, 0))
}

/** Take the first `limit` rows across gateway sections (and optional leading group count). */
export function takeGatewaySections<T extends { rows: unknown[] }>(
  sections: T[],
  limit: number,
  leadingRows = 0
): { sections: T[]; remaining: number } {
  let remaining = Math.max(0, limit - leadingRows)

  if (remaining <= 0) {
    return { remaining: 0, sections: [] }
  }

  const out: T[] = []

  for (const section of sections) {
    if (remaining <= 0) {
      break
    }

    const rows = section.rows.slice(0, remaining) as T['rows']
    remaining -= rows.length
    out.push({ ...section, rows })
  }

  return { remaining, sections: out }
}
