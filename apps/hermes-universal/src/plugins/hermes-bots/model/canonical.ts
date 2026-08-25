/**
 * The canonical "Bot Chat" ladder — as a PURE decision function.
 *
 * Every bot has exactly one private chat, pinned by stored id in
 * `ui_meta['hermes-bots'].chat`. Six things can be true about that pin, and
 * desktop learned each of them the hard way: a pin can be live, rotated by a
 * context compaction, dead, absent with history behind it, absent with nothing
 * behind it, or briefly unreadable because the roster call failed. Getting one
 * of those wrong FORKS a bot's memory in two, silently.
 *
 * So the ladder is a function from what we know to what to do, and the store
 * only executes the verdict. That is what makes all six rungs testable without
 * a gateway.
 */

import { BOT_CHAT_TITLE } from '../ids'

/** What the exact-title lookup (`session.list {title}`) came back with. */
export interface TitleLookup {
  /** The durable ROOT id. */
  id: string
  /** The live tip a resume should target after context compression. */
  resolvedId?: string
  /** Checked, because an older gateway ignores the `title` param and answers a
   *  normal listing — a one-element result is not proof of a match. */
  title: string
}

export interface CanonicalInput {
  /** `ui_meta.chat` — the durable pin, or null/absent. */
  pin?: null | string
  /** The exact-title lookup's answer. `null` means we looked and there is no
   *  Bot Chat; ABSENT means we did not look — those lead to different rungs. */
  lookup?: null | TitleLookup
  /** True when the pin was resumed and the gateway could not hydrate it. */
  pinHydrationFailed?: boolean
  /** True when the roster/lookup call itself failed (transport, not a miss). */
  lookupFailed?: boolean
}

export type CanonicalAction =
  /** Resume `storedId`; keep `pin` exactly as it is. */
  | { kind: 'resume'; storedId: string }
  /** Resume the live tip, but the DURABLE pin stays the root (rule 17). */
  | { kind: 'resume-tip'; pin: string; storedId: string }
  /** Adopt an existing hidden Bot Chat and pin it. */
  | { kind: 'adopt'; storedId: string }
  /** The pin is definitively gone; clear it and mint a new chat. */
  | { kind: 'create' }
  /** The pin looks right but would not open. Never fork — offer Retry. */
  | { kind: 'retry'; storedId: string }

/**
 * Decide what to do about a bot's canonical chat.
 *
 * Rung order matters and each rung exists because of a specific failure:
 *
 *  1. A live pin resumes. Nothing else.
 *  2. A pin that WOULD not hydrate keeps the pin and offers Retry — forking
 *     here is how a bot loses its history to a transient gateway hiccup.
 *  3. A rotated pin opens the live TIP while the durable pin stays the root:
 *     the pin is a stored id and aliasing is core's job (rule 17).
 *  4. No pin, but an exact-title hit: ADOPT it. This is what makes the flow
 *     idempotent across clients — two machines never mint two Bot Chats.
 *  5. No pin and no hit: create.
 *  6. A FAILED lookup is not a miss. With a pin in hand we keep it and retry;
 *     without one we refuse to mint, because minting on a transport error is
 *     how a duplicate is born.
 *
 * An ORDINARY session is never claimed: the title must be exactly `Bot Chat`,
 * checked here rather than trusted from the caller, because an older gateway
 * answers a title query with a plain listing.
 */
export function resolveCanonicalChat(input: CanonicalInput): CanonicalAction {
  const hit = input.lookup && input.lookup.title === BOT_CHAT_TITLE ? input.lookup : null

  if (input.pin) {
    if (input.pinHydrationFailed) {
      return { kind: 'retry', storedId: input.pin }
    }

    if (input.lookupFailed) {
      // A transient failure must not cost the pin.
      return { kind: 'resume', storedId: input.pin }
    }

    if (hit && hit.id === input.pin && hit.resolvedId && hit.resolvedId !== input.pin) {
      return { kind: 'resume-tip', pin: input.pin, storedId: hit.resolvedId }
    }

    if (hit && hit.id === input.pin) {
      return { kind: 'resume', storedId: input.pin }
    }

    if (input.lookup === undefined) {
      // Nothing was LOOKED UP — distinct from `null`, which means we looked and
      // the chat is gone. The pin is all we have and it is enough.
      return { kind: 'resume', storedId: input.pin }
    }

    // The pin is definitively gone. Re-pin onto the surviving Bot Chat if there
    // is one; never onto an arbitrary recent session.
    return hit ? { kind: 'adopt', storedId: hit.resolvedId ?? hit.id } : { kind: 'create' }
  }

  if (input.lookupFailed) {
    // No pin AND no answer: minting here is how a second Bot Chat appears on a
    // flaky connection. The caller surfaces the failure instead.
    return { kind: 'retry', storedId: '' }
  }

  return hit ? { kind: 'adopt', storedId: hit.resolvedId ?? hit.id } : { kind: 'create' }
}

/**
 * May the hide sweep touch this session?
 *
 * TWO guards, because `session.set_hidden` flips a session's WHOLE compression
 * lineage: a wrong call buries a real conversation and every ancestor of it.
 *
 *  - the id must be one this plugin OWNS (a pin, or a room member session);
 *  - the row's title must be one this plugin MINTS.
 *
 * A stale pin pointing at an ordinary session fails the second guard, and the
 * right repair is to fix the pin, not to hide someone's chat.
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
