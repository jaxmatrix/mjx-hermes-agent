/**
 * Which session IS a bot's canonical chat — as a PURE decision function.
 *
 * A bot has exactly one private chat, and its one and only identity is the
 * pair (profile, session titled exactly "Bot Chat"). The core schema's UNIQUE
 * title index makes that pair a registry holding at most one row, so the
 * question "which session is it" has a server-side answer that every client
 * and every machine agrees on, and there is nothing durable to keep in sync.
 *
 * THERE IS NO SESSION-ID PIN, and re-adding one is not an option — not as a
 * cache, not as a fallback tier, not "for verification". A pin is a second
 * identity that can disagree with the first, and every way it disagreed forked
 * a bot's memory in two: pinning an id that was never a row, pinning a session
 * a compaction had rotated, pinning one a peer had already replaced.
 *
 * What is left is one question with three answers, and the store only executes
 * the verdict — which is what makes this testable without a gateway.
 */

import { BOT_CHAT_TITLE } from '../ids'

/** One row from the exact-title registry lookup (`session.list {title}`). */
export interface RegistryRow {
  /** The durable ROOT id — the row that carries the title. */
  id: string
  /** The live tip a resume should target after context compression. */
  resolvedId?: string
  /** Checked here, never trusted from the caller: an older gateway ignores the
   *  `title` param and answers an ordinary listing, whose first row is some
   *  real conversation of the user's. */
  title: string
  /** Drives `expectHistory` on the open. Absent on an older gateway. */
  messageCount?: number
}

/**
 * What the registry said.
 *
 * `failed` and `row: null` are DIFFERENT facts and collapsing them is how a
 * duplicate is born: one means "we did not get an answer", the other means
 * "there is no Bot Chat".
 */
export type RegistryAnswer = { failed: true } | { failed?: false; row: null | RegistryRow }

export type CanonicalVerdict =
  /** Open this session. `expectHistory` tells the wake what to wait for. */
  | { kind: 'open'; storedId: string; expectHistory: boolean }
  /** No Bot Chat exists. Mint one. */
  | { kind: 'create' }
  /** We could not find out. Report it — never mint on an unanswered question. */
  | { kind: 'unavailable' }

/**
 * Decide what to do about a bot's canonical chat.
 *
 * `mayMint: false` is the re-entry after a title collision: another writer took
 * the canonical title between our miss and our write, so we re-ask. A SECOND
 * miss there means the registry contradicted the database, and minting again
 * on that is precisely the duplicate this design exists to prevent.
 */
export function resolveCanonicalChat(
  answer: RegistryAnswer,
  options: { mayMint?: boolean } = {}
): CanonicalVerdict {
  if (answer.failed) {
    // Minting on a transport error is how a second Bot Chat appears on a flaky
    // connection. The caller surfaces the failure instead.
    return { kind: 'unavailable' }
  }

  const row = answer.row && answer.row.title === BOT_CHAT_TITLE ? answer.row : null

  if (row) {
    return {
      // The tip, so a compacted lineage resumes where the conversation is.
      // There is no pin to keep pointing at the root, which is the whole
      // simplification: identity is the title, and the title is on the root.
      expectHistory: (row.messageCount ?? 0) > 0,
      kind: 'open',
      storedId: row.resolvedId ?? row.id
    }
  }

  return options.mayMint === false ? { kind: 'unavailable' } : { kind: 'create' }
}

/**
 * Is the focused session a bot's canonical chat?
 *
 * The basis for the `/new` rewrite below, and deliberately two independent
 * sources OR-ed together, neither of which costs an RPC on a keystroke path:
 * the ids this session actually opened (exact, but does not survive a reload)
 * and the ids the roster's registry lookup named (survives a reload, but only
 * as fresh as the last poll).
 */
export function isCanonicalChatSession(
  focusedStoredId: null | string,
  openedHere: ReadonlySet<string>,
  knownCanonicalIds: ReadonlySet<string>
): boolean {
  if (!focusedStoredId) {
    return false
  }

  return openedHere.has(focusedStoredId) || knownCanonicalIds.has(focusedStoredId)
}

/**
 * May the hide sweep touch this session?
 *
 * TWO guards, because `session.set_hidden` flips a session's WHOLE compression
 * lineage: a wrong call buries a real conversation and every ancestor of it.
 *
 *  - PROVENANCE: the id must have reached us from an exact-title registry
 *    lookup this plugin issued, on a profile in our own roster. There is no
 *    other door — no listing, no recency window, no `last_session`, and since
 *    the pin is gone, no stored pointer that could have gone stale.
 *  - IDENTITY: the title the gateway REPORTED for that row must be one this
 *    plugin mints. Checked separately, because an older gateway answers a title
 *    query with an ordinary listing, and its first row is someone's real work.
 *
 * Two guards rather than one, because either alone still hides a conversation:
 * provenance without identity trusts a stale answer, identity without
 * provenance trusts a row we never asked for.
 */
export function maySweep(input: { owned: boolean; title?: null | string }): boolean {
  if (!input.owned || !input.title) {
    return false
  }

  return input.title === BOT_CHAT_TITLE || input.title.startsWith('Group: ')
}

/**
 * `/new` inside a bot's canonical chat means `/compact`.
 *
 * A bot has exactly ONE chat, and that is its memory. `/new` there would fork
 * it — the durable pin would still point at the old conversation while the user
 * talked into a fresh one, and the bot would appear to have forgotten
 * everything with no way back. `/compact` is what the user actually wants: keep
 * the thread, shorten the context.
 *
 * Pure, and scoped by an explicit predicate rather than a guess: OUTSIDE a
 * canonical chat, `/new` is left completely alone.
 */
export function rewriteNewCommand(text: string, inCanonicalChat: boolean): string {
  if (!inCanonicalChat) {
    return text
  }

  // Only a leading `/new`, and only as a whole command — `/newsletter` and a
  // `/new` quoted mid-sentence are ordinary text.
  return text.replace(/^\/new(?=$|\s)/, '/compact')
}
