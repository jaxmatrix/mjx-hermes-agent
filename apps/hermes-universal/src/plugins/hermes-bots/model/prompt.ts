/**
 * The turn prompt — one grammar, pure, snapshot-tested.
 *
 * Deliberately NOT a plug point: a second prompt grammar would silently change
 * every bot's behaviour in every room, and nobody would be able to tell which
 * one produced a given transcript.
 *
 * Hostile text stays LITERAL. A bot title, a profile name or a room name that
 * looks like a shell fragment rides `prompt.submit` as data — universal never
 * builds a shell command — so the only hardening needed here is against text
 * that would be read as protocol: control characters, and a forged envelope
 * line. Both are stripped from names before they are interpolated.
 */

import { botDisplayName, botHandle } from '../ids'

import type { Speaker } from './mentions'
import { buildRoomEnvelope, GROUP_CHAT_HISTORY_LIMIT, type RoomLine } from './transcript'

/** Names go through here before they touch a prompt. The control range is the
 *  POINT: a NUL or a newline inside a name is how it hides a second protocol
 *  line inside itself, which is the one way hostile text here stops being data. */
// eslint-disable-next-line no-control-regex
export const literalName = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'agent'

export interface TurnPromptInput {
  roomId: string
  roomName: string
  thread: string
  /** The member about to speak. */
  viewer: Speaker
  members: readonly Speaker[]
  /** Lines this member has not seen, oldest first. */
  delta: readonly RoomLine[]
  /** Refs already staged into this member's session. */
  refs?: readonly { name: string; ref: string }[]
  /** The envelope's authoritative timestamp — minted ONCE by the sender. */
  at: number
}

const nameFor = (speaker: Speaker): string => literalName(speaker.handle ?? botDisplayName(speaker.profile))

/**
 * Build the whole prompt for one member's turn.
 *
 * The envelope is line 0 and carries the room, the thread and the `at` the
 * whole merge keys on. Everything after it is what the model actually reads.
 */
export function buildTurnPrompt(input: TurnPromptInput): string {
  const roomName = literalName(input.roomName)

  const roster = input.members
    .filter(member => member.profile !== input.viewer.profile)
    .map(member => `@${botHandle(member.profile)}`)
    .join(', ')

  const window = input.delta.slice(-GROUP_CHAT_HISTORY_LIMIT)

  const body = window
    .map(line => `${line.from.kind === 'user' ? 'You' : nameFor({ profile: line.from.profile })}: ${line.text}`)
    .join('\n')

  const refs = (input.refs ?? []).map(ref => `${ref.name}: ${ref.ref}`).join('\n')

  return [
    buildRoomEnvelope({
      at: input.at,
      from: { handle: botHandle(input.viewer.profile), kind: 'member' },
      roomId: input.roomId,
      thread: input.thread
    }),
    '',
    `You are @${botHandle(input.viewer.profile)} in the group room "${roomName}".`,
    roster ? `The other members are: ${roster}. The user is "You".` : 'You are the only agent in this room.',
    '',
    'New messages since your last turn:',
    body || '(nothing new)',
    ...(refs ? ['', 'Attached for this turn:', refs] : []),
    '',
    'Reply with your contribution only — no preamble, no restating what was said.',
    'Mention @someone to hand the conversation to them.',
    'If you have nothing to add, reply exactly: (pass)'
  ].join('\n')
}

/**
 * The prompt a USER turn is delivered with — the envelope plus the text, and
 * nothing else. The gateway's teammate protocol supplies the rest.
 */
export function buildUserTurnPrompt(input: { at: number; roomId: string; text: string; thread: string }): string {
  return `${buildRoomEnvelope({
    at: input.at,
    from: { kind: 'user' },
    roomId: input.roomId,
    thread: input.thread
  })}\n\n${input.text}`
}
