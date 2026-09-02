import { describe, expect, it } from 'vitest'

import { isCanonicalChatSession, maySweep, resolveCanonicalChat, rewriteNewCommand } from './canonical'

const T = 'Bot Chat'

describe('which session is the canonical Bot Chat', () => {
  it('opens the registry row, and the TIP when a compaction rotated it', () => {
    expect(resolveCanonicalChat({ row: { id: 'root', messageCount: 4, resolvedId: 'tip', title: T } })).toEqual({
      expectHistory: true,
      kind: 'open',
      storedId: 'tip'
    })
  })

  it('opens the root when there is no lineage to follow', () => {
    expect(resolveCanonicalChat({ row: { id: 'root', messageCount: 2, title: T } })).toMatchObject({
      kind: 'open',
      storedId: 'root'
    })
  })

  it('creates when the registry says this bot has no chat', () => {
    expect(resolveCanonicalChat({ row: null })).toEqual({ kind: 'create' })
  })

  it('NEVER claims an ordinary session, whatever the lookup answered', () => {
    // An older gateway ignores the `title` param and answers a plain listing,
    // whose first row is real work of the user's. A bot's chat and an ordinary
    // session are different modes of conversation; this is the line between
    // them, and it is checked here rather than trusted from the caller.
    expect(resolveCanonicalChat({ row: { id: 'theirs', title: 'Refactor the parser' } })).toEqual({
      kind: 'create'
    })
  })

  it('refuses to mint when the registry did not ANSWER — that is how a duplicate is born', () => {
    // "We did not get an answer" and "there is no Bot Chat" are different facts.
    expect(resolveCanonicalChat({ failed: true })).toEqual({ kind: 'unavailable' })
  })

  it('refuses to mint a SECOND time after a title collision', () => {
    // The re-entry after another writer took the title: a second miss means the
    // registry contradicted the database, and minting on that forks the memory.
    expect(resolveCanonicalChat({ row: null }, { mayMint: false })).toEqual({ kind: 'unavailable' })
  })

  it('waits for a transcript only when there is one to wait for', () => {
    // `expectHistory: true` on an empty chat is a 40-second hang that then
    // reports failure; an absent count is treated as empty for that reason.
    expect(resolveCanonicalChat({ row: { id: 'a', messageCount: 0, title: T } })).toMatchObject({
      expectHistory: false
    })
    expect(resolveCanonicalChat({ row: { id: 'a', title: T } })).toMatchObject({ expectHistory: false })
    expect(resolveCanonicalChat({ row: { id: 'a', messageCount: 1, title: T } })).toMatchObject({
      expectHistory: true
    })
  })
})

describe('telling a bot chat apart from an ordinary session', () => {
  it('recognises one this window opened, and one the roster named', () => {
    expect(isCanonicalChatSession('s1', new Set(['s1']), new Set())).toBe(true)
    expect(isCanonicalChatSession('s1', new Set(), new Set(['s1']))).toBe(true)
  })

  it('does not claim an ordinary session, or nothing at all', () => {
    expect(isCanonicalChatSession('s1', new Set(['other']), new Set(['another']))).toBe(false)
    expect(isCanonicalChatSession(null, new Set(['s1']), new Set(['s1']))).toBe(false)
  })
})

describe('the hide sweep guards', () => {
  // `session.set_hidden` flips a session's WHOLE compression lineage, so a wrong
  // call buries a real conversation and every ancestor of it.
  it('hides only titles this plugin mints', () => {
    expect(maySweep({ owned: true, title: 'Bot Chat' })).toBe(true)
    expect(maySweep({ owned: true, title: 'Group: Ops' })).toBe(true)
    expect(maySweep({ owned: true, title: 'Refactor the parser' })).toBe(false)
  })

  it('never follows a stale pin to a session this plugin does not own', () => {
    expect(maySweep({ owned: false, title: 'Bot Chat' })).toBe(false)
  })

  it('skips a row whose title it could not read, rather than guessing', () => {
    expect(maySweep({ owned: true })).toBe(false)
    expect(maySweep({ owned: true, title: null })).toBe(false)
  })
})

describe('the /new reroute', () => {
  // A bot has ONE chat, and that chat is its memory. `/new` there would fork it:
  // the durable pin keeps pointing at the old conversation while the user talks
  // into a fresh one, and the bot appears to have forgotten everything.
  it('rewrites a leading /new to /compact inside a canonical chat', () => {
    expect(rewriteNewCommand('/new', true)).toBe('/compact')
    expect(rewriteNewCommand('/new please', true)).toBe('/compact please')
  })

  it('leaves /new completely alone OUTSIDE a canonical chat', () => {
    expect(rewriteNewCommand('/new', false)).toBe('/new')
  })

  it('only matches a whole leading command', () => {
    expect(rewriteNewCommand('/newsletter', true)).toBe('/newsletter')
    expect(rewriteNewCommand('type /new to start over', true)).toBe('type /new to start over')
  })
})
