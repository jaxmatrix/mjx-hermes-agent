// Small array helpers shared by the sidebar layout/pane stores. Ported from
// desktop's `lib/storage.ts` (the persisted read/write choke point already lives
// in `@/lib/persist` here, so only these order helpers are carried over).

import { readKey, writeKey } from '@/lib/persist'

// Re-export the raw read/write choke point so ports that import them from
// `@/lib/storage` (desktop's home for these) resolve here without churning
// every call site. The single choke point still lives in `@/lib/persist`.
export { readKey, writeKey }

/** Parsed JSON read. Returns null on absence, unavailable storage, OR malformed
 *  JSON — callers layer their own shape validation on the parsed value. */
export function readJson<T>(key: string): T | null {
  const raw = readKey(key)

  if (raw === null) {
    return null
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** JSON write; a null value removes the key. Best-effort (see writeKey). */
export function writeJson(key: string, value: unknown) {
  writeKey(key, value === null ? null : JSON.stringify(value))
}

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
