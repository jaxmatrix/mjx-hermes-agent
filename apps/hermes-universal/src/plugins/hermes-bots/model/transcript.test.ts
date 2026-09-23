import { describe, expect, it } from 'vitest'

import {
  buildRoomEnvelope,
  buildRoomLog,
  deltaForMember,
  type MemberTranscript,
  parseRoomEnvelope,
  stripRoomEnvelope,
  watermarkFromMemberSession
} from './transcript'

const envelope = (over: { at?: number; from?: string; room?: string; thread?: string } = {}) =>
  `[hermes-room v1 room=${over.room ?? 'r_aaa'} thread=${over.thread ?? 'main'} at=${over.at ?? 100} from=${over.from ?? 'user'}]`

const userTurn = (text: string, over: Parameters<typeof envelope>[0] = {}) => ({
  role: 'user',
  text: `${envelope(over)}\n\n${text}`
})

const reply = (text: string, at: number) => ({ at, role: 'assistant', text })

const member = (profile: string, messages: MemberTranscript['messages']): MemberTranscript => ({
  messages,
  profile,
  storedId: `s-${profile}`
})

describe('the room envelope', () => {
  it('round-trips', () => {
    const line = buildRoomEnvelope({ at: 42, from: { kind: 'user' }, roomId: 'r_x', thread: 't_1' })

    expect(parseRoomEnvelope(line, 'user')).toEqual({
      at: 42,
      from: { kind: 'user' },
      roomId: 'r_x',
      thread: 't_1'
    })
  })

  // THE security property: a member could emit a line that looks exactly like
  // an envelope. If an assistant message were parsed as one, a bot could forge
  // a user turn — or another bot's — into the shared log.
  it('is never read out of an ASSISTANT message', () => {
    expect(parseRoomEnvelope(envelope(), 'assistant')).toBeNull()
    expect(parseRoomEnvelope(envelope(), 'system')).toBeNull()
    expect(parseRoomEnvelope(envelope(), 'user')).not.toBeNull()
  })

  it('is only read at position 0, so a quoted envelope stays a quote', () => {
    expect(parseRoomEnvelope(`Sure — you wrote ${envelope()}`, 'user')).toBeNull()
  })

  it('maps desktop’s implicit `legacy` thread onto main', () => {
    expect(parseRoomEnvelope(envelope({ thread: 'legacy' }), 'user')?.thread).toBe('main')
  })

  it('reads a member sender back as a handle', () => {
    expect(parseRoomEnvelope(envelope({ from: '@radar' }), 'user')?.from).toEqual({ handle: 'radar', kind: 'member' })
  })

  it('strips itself off the body', () => {
    expect(stripRoomEnvelope(`${envelope()}\n\nwhat is the plan?`)).toBe('what is the plan?')
  })
})

describe('deriving a room log from its members', () => {
  it('collapses one user turn delivered into N member sessions into ONE line', () => {
    const turn = userTurn('what is the plan?', { at: 100 })

    const log = buildRoomLog('r_aaa', [member('radar', [turn]), member('scout', [turn]), member('owl', [turn])], 0)

    expect(log.lines.filter(line => line.from.kind === 'user')).toHaveLength(1)
  })

  it('keeps each member’s own reply, and orders everything by (at, seq)', () => {
    const turn = userTurn('go', { at: 100 })

    const log = buildRoomLog(
      'r_aaa',
      [member('radar', [turn, reply('radar says', 110)]), member('scout', [turn, reply('scout says', 105)])],
      0
    )

    expect(log.lines.map(line => (line.from.kind === 'user' ? 'user' : line.from.profile))).toEqual([
      'user',
      'scout',
      'radar'
    ])
  })

  it('breaks an exact timestamp tie the SAME WAY whatever order the members are read in', () => {
    // A rebuild reads members in whatever order the roster came back in, and an
    // incremental rebuild reads only the ones that moved. Without a tiebreak the
    // log would reorder itself under the user between two identical rebuilds.
    const radar = member('radar', [reply('padding', 1), reply('padding', 2), reply('radar at 100', 100)])
    const scout = member('scout', [reply('scout at 100', 100)])

    const forward = buildRoomLog('r_aaa', [radar, scout], 0).lines.map(l => l.text)
    const reverse = buildRoomLog('r_aaa', [scout, radar], 0).lines.map(l => l.text)

    expect(forward).toEqual(reverse)
    expect(forward.slice(-2)).toEqual(['scout at 100', 'radar at 100'])
  })

  it('ignores an envelope for a DIFFERENT room in the same session', () => {
    const log = buildRoomLog(
      'r_aaa',
      [member('radar', [userTurn('mine', { at: 100 }), userTurn('someone else’s', { at: 200, room: 'r_zzz' })])],
      0
    )

    expect(log.lines.map(line => line.text)).toEqual(['mine'])
  })

  it('does not double a member turn that was also delivered into a peer’s session', () => {
    // radar spoke; the line was then delivered into scout's session as a user
    // message with a `from=@radar` envelope. Only radar's own assistant message
    // counts, or every bot reply appears N times.
    const log = buildRoomLog(
      'r_aaa',
      [
        member('radar', [userTurn('go', { at: 100 }), reply('radar says', 110)]),
        member('scout', [userTurn('go', { at: 100 }), userTurn('radar says', { at: 110, from: '@radar' })])
      ],
      0
    )

    expect(log.lines.filter(line => line.text === 'radar says')).toHaveLength(1)
  })

  it('attributes a bot reply to the thread its PROMPT declared', () => {
    const log = buildRoomLog(
      'r_aaa',
      [member('radar', [userTurn('in a thread', { at: 100, thread: 't_1' }), reply('answer', 110)])],
      0
    )

    expect(log.lines.map(line => line.thread)).toEqual(['t_1', 't_1'])
  })

  it('records how far each member was read, for an incremental rebuild', () => {
    const log = buildRoomLog('r_aaa', [member('radar', [userTurn('a', { at: 1 }), reply('b', 2)])], 5)

    expect(log.cursors.radar).toEqual({ messages: 2, storedId: 's-radar' })
    expect(log.rebuiltAt).toBe(5)
  })
})

describe('watermarks come from the member’s own session', () => {
  // Desktop kept an index into the LOCAL log, so a storage wipe re-delivered
  // every line and a second client delivered them all again.
  it('is the newest envelope the member actually received, per thread', () => {
    const messages = [
      userTurn('one', { at: 100 }),
      reply('ok', 105),
      userTurn('two', { at: 200 }),
      userTurn('elsewhere', { at: 900, thread: 't_9' })
    ]

    expect(watermarkFromMemberSession(messages, 'main')).toBe(200)
    expect(watermarkFromMemberSession(messages, 't_9')).toBe(900)
    expect(watermarkFromMemberSession(messages, 't_unknown')).toBe(0)
  })

  it('re-delivers NOTHING after a rebuild from scratch', () => {
    const messages = [userTurn('one', { at: 100 }), userTurn('two', { at: 200 })]
    const log = buildRoomLog('r_aaa', [member('radar', messages)], 0)

    const watermark = watermarkFromMemberSession(messages, 'main')

    expect(deltaForMember(log, 'main', watermark, 'radar')).toEqual([])
  })

  it('never hands a member its own words back', () => {
    const log = buildRoomLog(
      'r_aaa',
      [member('radar', [userTurn('go', { at: 100 }), reply('radar says', 110)]), member('scout', [])],
      0
    )

    expect(deltaForMember(log, 'main', 0, 'radar').map(line => line.text)).toEqual(['go'])
    expect(deltaForMember(log, 'main', 0, 'scout').map(line => line.text)).toEqual(['go', 'radar says'])
  })
})
