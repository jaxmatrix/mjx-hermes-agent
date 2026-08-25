/**
 * WHO SPEAKS NEXT — a deterministic `@mention` parse, and deliberately not an
 * LLM router.
 *
 * This is the whole scheduling policy of a room, and it is a pure function of
 * the text. That is a design position, not an implementation detail: making the
 * router pluggable is how an LLM router ships by accident, and an LLM deciding
 * who talks is both slower and non-reproducible — a room that answers
 * differently on a replay cannot be debugged.
 *
 * Everything here is pure.
 */

import { botHandle, MAIN_THREAD } from '../ids'

import type { RoomLine } from './transcript'

/** A member as the router sees it. */
export interface Speaker {
  profile: string
  connectionId?: string
  /** Display handle; falls back to the profile's own. */
  handle?: string
}

/** `@everyone` / `@all` address the room. */
const BROADCAST = new Set(['all', 'everyone', 'room'])

const MENTION_RE = /(?:^|[^\w@])@([a-z0-9][a-z0-9._-]*)/gi

/** Every `@tag` in a piece of text, lowercased, in order, deduped. */
export function parseMentions(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  for (const match of text.matchAll(MENTION_RE)) {
    // A trailing `.` is far more often a sentence than part of a slug.
    const tag = match[1].toLowerCase().replace(/[.]+$/, '')

    if (tag && !seen.has(tag)) {
      seen.add(tag)
      out.push(tag)
    }
  }

  return out
}

/** True when the text addresses the whole room rather than named members. */
export const isBroadcast = (text: string): boolean => parseMentions(text).some(tag => BROADCAST.has(tag))

const handleOf = (speaker: Speaker): string => (speaker.handle ?? botHandle(speaker.profile)).toLowerCase()

/**
 * Resolve the members a line addresses.
 *
 * No mention at all, or a broadcast tag, means everyone — a room where an
 * unaddressed message goes nowhere reads as broken. A member never answers
 * itself, which is what stops a bot mentioning its own name from looping.
 */
export function resolveResponders(line: RoomLine, members: readonly Speaker[]): Speaker[] {
  const speaking = line.from.kind === 'member' ? line.from.profile : null
  const others = members.filter(member => member.profile !== speaking)
  const tags = parseMentions(line.text)

  if (tags.length === 0 || tags.some(tag => BROADCAST.has(tag))) {
    return others
  }

  const wanted = new Set(tags)
  const named = others.filter(member => wanted.has(handleOf(member)))

  // Every tag was a stranger (a typo, a filename, an email). Treating that as
  // "nobody speaks" makes the room look dead; treating it as a broadcast makes
  // six agents answer a typo. Silence is the honest one — the UI says so.
  return named
}

/**
 * Rotate who goes first each round.
 *
 * Without it the same member always opens, which biases every conversation
 * toward whoever happens to sort first — and makes a round-2 reply read as a
 * repeat of round 1.
 */
export function rotateSpeakers<T>(speakers: readonly T[], round: number): T[] {
  if (speakers.length === 0) {
    return []
  }

  const at = round % speakers.length

  return [...speakers.slice(at), ...speakers.slice(0, at)]
}

/**
 * The `(pass)` protocol: a member with nothing to add says so, and that is not
 * a message.
 *
 * An EMPTY reply counts as a pass too — a model that answers with whitespace
 * has said nothing, and posting an empty bubble is worse than posting nothing.
 */
export function isPassText(text: string): boolean {
  const trimmed = text.trim().toLowerCase()

  if (!trimmed) {
    return true
  }

  return /^\(?pass\)?[.!]?$/.test(trimmed)
}

/** The mention token under the caret, for composer completions. */
export function mentionTokenAt(text: string, caret: number): null | { query: string; start: number } {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')

  if (at < 0) {
    return null
  }

  // `@` only starts a mention at a word boundary — an email address must not
  // open the popover.
  if (at > 0 && /[\w@]/.test(before[at - 1])) {
    return null
  }

  const query = before.slice(at + 1)

  return /^[a-z0-9._-]*$/i.test(query) ? { query, start: at } : null
}

/**
 * Rank roster rows for the `@` popover: PREFIX matches only, never substring.
 *
 * A substring match puts `@radar` under `da`, which on a roster of a dozen
 * agents means the first row is almost never the one you meant.
 */
export function matchHandles(query: string, members: readonly Speaker[], limit = 8): Speaker[] {
  const needle = query.toLowerCase()

  return members.filter(member => handleOf(member).startsWith(needle)).slice(0, limit)
}

/** The thread a new line belongs to, defaulting to the room's main thread. */
export const threadOr = (thread: null | string | undefined): string => thread || MAIN_THREAD
