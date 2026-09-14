import { describe, expect, it } from 'vitest'

import { isBroadcast, isPassText, matchHandles, mentionTokenAt, parseMentions, resolveResponders, rotateSpeakers } from './mentions'
import type { RoomLine } from './transcript'

const members = [{ profile: 'radar' }, { profile: 'scout' }, { profile: 'owl' }, { profile: 'default' }]

const line = (text: string, from: RoomLine['from'] = { kind: 'user' }): RoomLine => ({
  at: 1,
  from,
  seq: 0,
  text,
  thread: 'main'
})

const names = (speakers: { profile: string }[]) => speakers.map(speaker => speaker.profile)

describe('parsing mentions', () => {
  it('finds tags at a word boundary and dedupes them', () => {
    expect(parseMentions('hey @radar and @scout, @radar again')).toEqual(['radar', 'scout'])
  })

  it('does not read an email address as a mention', () => {
    expect(parseMentions('write to nobody@example.com')).toEqual([])
  })

  it('drops a trailing sentence dot but keeps an interior one', () => {
    expect(parseMentions('ask @radar.')).toEqual(['radar'])
    expect(parseMentions('ask @radar.two')).toEqual(['radar.two'])
  })

  it('recognises the broadcast tags', () => {
    expect(isBroadcast('@everyone please look')).toBe(true)
    expect(isBroadcast('@all')).toBe(true)
    expect(isBroadcast('@radar')).toBe(false)
  })
})

describe('who answers', () => {
  it('answers as a room when nothing is mentioned', () => {
    expect(names(resolveResponders(line('what is the plan?'), members))).toEqual(['radar', 'scout', 'owl', 'default'])
  })

  it('answers only the members that were named', () => {
    expect(names(resolveResponders(line('@radar @scout thoughts?'), members))).toEqual(['radar', 'scout'])
  })

  it('never answers itself', () => {
    const spoken = line('@radar what do you think, @scout?', { kind: 'member', profile: 'radar' })

    expect(names(resolveResponders(spoken, members))).toEqual(['scout'])
  })

  it('lets a bot hand the conversation to another bot', () => {
    const spoken = line('good point — @owl, over to you', { kind: 'member', profile: 'radar' })

    expect(names(resolveResponders(spoken, members))).toEqual(['owl'])
  })

  it('addresses the default profile as @hermes, never @default', () => {
    expect(names(resolveResponders(line('@hermes take this'), members))).toEqual(['default'])
    expect(names(resolveResponders(line('@default take this'), members))).toEqual([])
  })

  it('stays silent when every tag is a stranger, rather than waking the room', () => {
    // Six agents answering a typo is worse than nobody answering it, and the UI
    // says which tag did not resolve.
    expect(resolveResponders(line('@nobody-here hello'), members)).toEqual([])
  })

  it('treats a broadcast tag as everyone else', () => {
    const spoken = line('@everyone standup', { kind: 'member', profile: 'radar' })

    expect(names(resolveResponders(spoken, members))).toEqual(['scout', 'owl', 'default'])
  })

  it('honours an explicit handle override', () => {
    const renamed = [{ handle: 'r2', profile: 'radar' }, { profile: 'scout' }]

    expect(names(resolveResponders(line('@r2 hi'), renamed))).toEqual(['radar'])
    expect(names(resolveResponders(line('@radar hi'), renamed))).toEqual([])
  })
})

describe('round rotation', () => {
  it('starts each round with a different speaker', () => {
    const order = ['a', 'b', 'c']

    expect(rotateSpeakers(order, 0)).toEqual(['a', 'b', 'c'])
    expect(rotateSpeakers(order, 1)).toEqual(['b', 'c', 'a'])
    expect(rotateSpeakers(order, 2)).toEqual(['c', 'a', 'b'])
    expect(rotateSpeakers(order, 3)).toEqual(['a', 'b', 'c'])
  })

  it('survives an empty roster', () => {
    expect(rotateSpeakers([], 2)).toEqual([])
  })
})

describe('the (pass) protocol', () => {
  it.each(['(pass)', 'pass', 'pass.', 'PASS', '  (Pass) ', ''])('reads %j as a pass', text => {
    expect(isPassText(text)).toBe(true)
  })

  it.each(['passing the ball', 'I pass on that because…', 'no'])('does not read %j as a pass', text => {
    expect(isPassText(text)).toBe(false)
  })
})

describe('composer completions', () => {
  it('finds the mention token under the caret', () => {
    expect(mentionTokenAt('hey @rad', 8)).toEqual({ query: 'rad', start: 4 })
    expect(mentionTokenAt('hey @rad more', 8)).toEqual({ query: 'rad', start: 4 })
  })

  it('does not open on an email address', () => {
    expect(mentionTokenAt('nobody@exa', 10)).toBeNull()
  })

  it('closes once the token stops looking like a handle', () => {
    expect(mentionTokenAt('@rad ar', 7)).toBeNull()
  })

  it('matches by PREFIX only, and caps the rows', () => {
    const roster = [{ profile: 'radar' }, { profile: 'radio' }, { profile: 'scout' }]

    expect(matchHandles('ra', roster).map(r => r.profile)).toEqual(['radar', 'radio'])
    // A substring match would put `radar` under `da`, and the first row would
    // almost never be the one you meant.
    expect(matchHandles('da', roster)).toEqual([])
    expect(matchHandles('', Array.from({ length: 20 }, (_, i) => ({ profile: `b${i}` })))).toHaveLength(8)
  })
})
