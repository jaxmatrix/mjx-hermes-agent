// Small array helpers shared by the sidebar layout/pane stores. Ported from
// desktop's `lib/storage.ts` (the persisted read/write choke point already lives
// in `@/lib/persist` here, so only these order helpers are carried over).

/** Referential shortcut: two id lists are equal iff same length + same order. */
export function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/** Move/insert `id` at `index`, de-duping any prior occurrence. Index is clamped. */
export function insertUniqueId(ids: string[], id: string, index: number): string[] {
  const next = ids.filter(item => item !== id)
  const boundedIndex = Math.min(Math.max(index, 0), next.length)
  next.splice(boundedIndex, 0, id)

  return next
}
