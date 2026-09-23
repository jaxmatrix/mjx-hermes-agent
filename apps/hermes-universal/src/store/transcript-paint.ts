/**
 * THE PAINT LANE: provisional transcript rows that are PIXELS, never knowledge.
 *
 * Desktop reads its cached tail straight into the session's messages and guards
 * every consumer with an identity latch — a promise that six present call sites
 * and every future one remember to check. Universal cannot make that promise:
 * it has more readers, and its reducer REPLACES the array on every delta, which
 * breaks identity and silently releases such a latch.
 *
 * So the guard is structural. The cached rows are not in `$sessionKeyStates` at
 * all, and exactly one projection can see them
 * (`SessionView.$paintedMessages` → `app/chat/runtime.tsx`). Three universal
 * readers would each have consumed them as knowledge, and every one is a shipped
 * bug shape:
 *
 *  1. `store/turn-hydration.ts`'s rekey hook runs
 *     `reconcileLiveTail(authoritative, previous.messages)`, and
 *     `reconcileResumeMessages` pairs rows BY ROLE ORDINAL. A 40-row cached tail
 *     against a 300-row transcript would pair row 1 with row 1 — different turns
 *     entirely — and graft one turn's reasoning and tool calls onto another's.
 *     The transcript would be silently, permanently wrong.
 *  2. The crash journal writes `state.messages` for every busy slice, and a
 *     hydrating slice is seeded `busy: true` — so a cache would be journaled as
 *     a live in-flight turn and folded back in as recovered work.
 *  3. `store/voice-reply-cursor.ts` narrates `view.$messages`: the voice loop
 *     would read the cached tail aloud on a cold open (MJXHRM-484's exact bug).
 *
 * Plus `branchSourceOf` would fork a chat from cached rows, and the reducer
 * would append live deltas onto them.
 *
 * The contract is one line, and it is enforced by naming:
 * **`$messages` is knowledge, `$paintedMessages` is pixels.** Anything that
 * reconciles, journals, narrates, branches or submits reads `$messages`.
 */

import type { ChatMessage } from '@/lib/session-key-messages'
import { readTranscriptTail } from '@/lib/transcript-tail-cache'
import { atom } from '@/store/atom'
import { $sessionKeyStates, scopedStoredKey } from '@/store/session-state-types'

export interface PaintedTail {
  /** The slice key this paint belongs to — `hydrating:<storedId>` for a cold
   *  open, or `BOOT_PAINT_KEY` for the pre-connection boot paint. */
  key: string
  storedSessionId: string
  /** DISPLAY ONLY. Never reconciled, journaled, narrated, branched or submitted
   *  from. Not in `$sessionKeyStates` on purpose — see the module header. */
  messages: ChatMessage[]
  paintedAt: number
}

/** The boot paint's key. Not a session key: at boot there is no slice, no
 *  runtime binding and no composer — deliberately, because setting the active
 *  stored id before a runtime binding exists would make the composer's
 *  `ensureSession()` create a BRAND-NEW session on the first keystroke. */
export const BOOT_PAINT_KEY = 'boot'

/** Bounded by construction: one entry per in-flight cold open, plus at most one
 *  boot paint. */
export const $transcriptPaint = atom<Record<string, PaintedTail>>({})

/**
 * Put a session's cached tail on screen under `key`.
 *
 * Refuses — returning false, never throwing — when there is already a paint for
 * the key, when the cache misses, or when the slice already holds messages. That
 * last one is what keeps a paint off the warm paths: a promoted or reclaimed
 * session's transcript is already correct and richer than any cache, so painting
 * over it would be a flicker on top of the right answer.
 */
/**
 * The cache key a slice's tail is filed under (MJXHRM-591).
 *
 * The SCOPED stored key, not the bare id: two backends mint the same
 * `uuid4().hex[:8]`, so one cache keyed by the id alone would paint another
 * machine's conversation under a same-named session — the hazard the switch
 * used to answer by wiping every tail, which cost every bound tab its cache
 * along with it. Scoping the key closes the bleed AND keeps the tails; for the
 * local connection's default profile it is the bare id, so a single-source
 * install's entries are byte-identical to the ones already on disk.
 */
export const transcriptTailKey = scopedStoredKey

export function paintCachedTail(key: string, storedSessionId: null | string): boolean {
  if (!key || !storedSessionId) {
    return false
  }

  if ($transcriptPaint.get()[key]) {
    return false
  }

  if ($sessionKeyStates.get()[key]?.messages.length) {
    return false
  }

  const messages = readTranscriptTail(transcriptTailKey(key, storedSessionId))

  if (!messages?.length) {
    return false
  }

  $transcriptPaint.set({
    ...$transcriptPaint.get(),
    [key]: { key, messages, paintedAt: Date.now(), storedSessionId }
  })

  return true
}

/** Drop one paint, or every paint when called with no key. Idempotent: the cold
 *  open clears in its success path, its catch AND its finally. */
export function clearTranscriptPaint(key?: string): void {
  const current = $transcriptPaint.get()

  if (key === undefined) {
    if (Object.keys(current).length) {
      $transcriptPaint.set({})
    }

    return
  }

  if (!(key in current)) {
    return
  }

  const { [key]: _dropped, ...rest } = current

  $transcriptPaint.set(rest)
}

/** Test seam. */
export function __resetTranscriptPaint(): void {
  $transcriptPaint.set({})
}
