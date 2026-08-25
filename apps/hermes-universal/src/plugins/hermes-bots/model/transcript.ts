/**
 * The DERIVED transcript — pure.
 *
 * A room has no log of record. Every prompt Bot Mode submits into a member
 * session opens with one parseable line:
 *
 *     [hermes-room v1 room=<roomId> thread=<threadId> at=<ms> from=user|@<handle>]
 *
 * so a member session DESCRIBES its own share of the room. User turns come back
 * out of those envelopes; bot turns are the member's own assistant messages,
 * timestamped by the gateway. Merge on `(at, seq)` and the room log is a
 * function of server state — it survives a storage wipe, a new device and a
 * second client, none of which desktop's client-only log did.
 *
 * SECURITY: the envelope is not a trust boundary. A model can emit a line that
 * looks exactly like one, so an envelope is only read at position 0 of a USER
 * message. An assistant message is never parsed as an envelope, and therefore a
 * bot cannot forge a user turn (or another bot's).
 */

import { MAIN_THREAD } from '../ids'

export const ROOM_ENVELOPE_VERSION = 'v1'

export interface RoomEnvelope {
  roomId: string
  thread: string
  at: number
  from: { kind: 'user' } | { handle: string; kind: 'member' }
}

export interface RoomLine {
  at: number
  from: { kind: 'user' } | { connectionId?: string; kind: 'member'; profile: string }
  text: string
  thread: string
  /** Per-(session, message index) tiebreak for equal `at`. */
  seq: number
  refs?: { name: string; ref: string }[]
}

export interface RoomLogCursor {
  storedId: string
  messages: number
}

export interface RoomLog {
  lines: RoomLine[]
  cursors: Record<string, RoomLogCursor>
  rebuiltAt: number
}

/** Lines kept per room after a rebuild. */
export const GROUP_CHAT_HISTORY_LIMIT = 24
export const ROOM_LOG_LIMIT = GROUP_CHAT_HISTORY_LIMIT * 4

/** Build the envelope line for a turn we are about to submit. */
export function buildRoomEnvelope(envelope: RoomEnvelope): string {
  const from = envelope.from.kind === 'user' ? 'user' : `@${envelope.from.handle}`

  return `[hermes-room ${ROOM_ENVELOPE_VERSION} room=${envelope.roomId} thread=${envelope.thread} at=${envelope.at} from=${from}]`
}

const ENVELOPE_RE = /^\[hermes-room v1 room=(\S+) thread=(\S+) at=(\d+) from=(\S+)\]/

/**
 * Read an envelope back out of a message.
 *
 * `role` is REQUIRED and checked: parsing an assistant message would let a bot
 * forge a user turn into the shared log. Position 0 only, for the same reason —
 * a bot quoting an envelope mid-reply must stay a quote.
 */
export function parseRoomEnvelope(text: string, role: string): null | RoomEnvelope {
  if (role !== 'user') {
    return null
  }

  const match = ENVELOPE_RE.exec(text)

  if (!match) {
    return null
  }

  const [, roomId, thread, at, from] = match

  return {
    at: Number(at),
    from: from === 'user' ? { kind: 'user' } : { handle: from.replace(/^@/, ''), kind: 'member' },
    roomId,
    // Desktop's rooms had one implicit thread it called `legacy`.
    thread: thread === 'legacy' ? MAIN_THREAD : thread
  }
}

/** The body of an enveloped prompt — everything after the envelope line. */
export const stripRoomEnvelope = (text: string): string => text.replace(ENVELOPE_RE, '').replace(/^\n+/, '')

/** One member's transcript, as REST hands it back. */
export interface MemberMessage {
  role: string
  text: string
  at?: number
}

export interface MemberTranscript {
  profile: string
  connectionId?: string
  storedId: string
  messages: MemberMessage[]
}

const lineKey = (line: RoomLine): string =>
  `${line.at}|${line.thread}|${line.from.kind === 'user' ? 'user' : line.from.profile}|${line.text}`

/**
 * Build the room log from its members' own transcripts.
 *
 * The DEDUPE is the crux: a user turn is delivered into every mentioned
 * member's session, so it comes back up to six times. The envelope carries the
 * authoritative `at` — minted ONCE, by the sender — so all N copies collapse to
 * one line. A member that never received a given turn simply contributes
 * nothing for it, which is correct: mention-scoping means not every member saw
 * everything, and the room log is the union of what was said.
 */
export function buildRoomLog(roomId: string, members: readonly MemberTranscript[], now: number): RoomLog {
  const lines: RoomLine[] = []
  const cursors: Record<string, RoomLogCursor> = {}
  const seen = new Set<string>()

  for (const member of members) {
    cursors[member.profile] = { messages: member.messages.length, storedId: member.storedId }

    // The thread a bot reply belongs to is the one its PROMPT declared — an
    // assistant message carries no envelope of its own.
    let thread = MAIN_THREAD

    member.messages.forEach((message, index) => {
      const envelope = parseRoomEnvelope(message.text, message.role)

      if (envelope) {
        if (envelope.roomId !== roomId) {
          return
        }

        thread = envelope.thread

        // A member turn already appears as that member's OWN assistant message;
        // the copy delivered into a peer's session would double it.
        if (envelope.from.kind !== 'user') {
          return
        }

        const line: RoomLine = {
          at: envelope.at,
          from: { kind: 'user' },
          seq: index,
          text: stripRoomEnvelope(message.text),
          thread
        }

        const key = lineKey(line)

        if (!seen.has(key)) {
          seen.add(key)
          lines.push(line)
        }

        return
      }

      if (message.role !== 'assistant') {
        return
      }

      lines.push({
        at: message.at ?? 0,
        from: {
          ...(member.connectionId ? { connectionId: member.connectionId } : {}),
          kind: 'member',
          profile: member.profile
        },
        seq: index,
        text: message.text,
        thread
      })
    })
  }

  lines.sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at - b.at))

  return { cursors, lines: lines.slice(-ROOM_LOG_LIMIT), rebuiltAt: now }
}

/**
 * How far a member has been told about — derived from the member's OWN session.
 *
 * Desktop kept `watermarks['<thread>::<member>']` as an index into the local
 * log. That is device-local by construction: a storage wipe re-delivered every
 * line, and a second client delivered them again. Here the watermark is the
 * `at` of the newest envelope in the member's own transcript, so a rebuild from
 * scratch never re-delivers.
 */
export function watermarkFromMemberSession(messages: readonly MemberMessage[], thread: string): number {
  let watermark = 0

  for (const message of messages) {
    const envelope = parseRoomEnvelope(message.text, message.role)

    if (envelope && envelope.thread === thread && envelope.at > watermark) {
      watermark = envelope.at
    }
  }

  return watermark
}

/** The lines a member has not been told about yet, in one thread. */
export function deltaForMember(log: RoomLog, thread: string, watermark: number, selfProfile: string): RoomLine[] {
  return log.lines.filter(
    line =>
      line.thread === thread &&
      line.at > watermark &&
      // A member is never handed its own words back.
      !(line.from.kind === 'member' && line.from.profile === selfProfile)
  )
}

/** Render one line the way a member reads it in a prompt. */
export function renderLine(line: RoomLine, nameOf: (profile: string) => string): string {
  const who = line.from.kind === 'user' ? 'You' : nameOf(line.from.profile)

  return `${who}: ${line.text}`
}
