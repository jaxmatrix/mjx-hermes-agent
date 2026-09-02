/**
 * The roster's EFFECTS: the canonical-chat registry as it actually calls the
 * gateway, and the hide sweep's two guards.
 *
 * The decision is already pinned in `model/canonical.test.ts`; what is pinned
 * here is that the store executes it — that an existing chat is opened rather
 * than duplicated, that a new one is TITLED before it is opened (the write that
 * makes it a row at all), and above all that the sweep never asks the gateway
 * to hide a session it does not own.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { activeConnectionId, agents, connections, notify, notifyError, openSession, request, requestProfile } =
  vi.hoisted(() => ({
    activeConnectionId: vi.fn(),
    agents: vi.fn(),
    connections: vi.fn(),
    notify: vi.fn(),
    notifyError: vi.fn(),
    openSession: vi.fn(),
    request: vi.fn(),
    requestProfile: vi.fn()
  }))

// A PARTIAL mock: the store's own atoms come from the real SDK re-export, so
// only the host doors are stubbed. Mocking the module wholesale would replace
// `atom` too and every store in the tree would hold a different nanostore.
vi.mock('@hermes/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  host: {
    activeConnectionId,
    agents,
    connections,
    notify,
    notifyError,
    openSession,
    request,
    requestProfile,
    state: { liveSessions: { get: () => ({}) } }
  },
  livePollIntervalMs: (legacy: number) => legacy
}))

import { $rooms, $roster } from './atoms'
import { openBotChat, refreshRoster, saveBotMeta, sweepHiddenSessions } from './bots'

type Call = [string, Record<string, unknown>]

const calls = (method: string): Record<string, unknown>[] =>
  (request.mock.calls as Call[]).filter(([name]) => name === method).map(([, params]) => params)

const profile = (name: string, uiMeta?: unknown) => ({
  has_avatar: false,
  is_default: name === 'default',
  name,
  ...(uiMeta === undefined ? {} : { ui_meta: uiMeta })
})

const row = (name: string, meta: Record<string, unknown> = {}) => ({
  connectionId: undefined,
  description: '',
  handle: name,
  hasAvatar: false,
  isDefault: false,
  key: name,
  lastActive: 0,
  meta,
  metaKnown: true,
  model: null,
  name,
  preview: '',
  profile: name,
  working: false
})

/** The registry answering with one row, plus a create that reports both ids. */
const registry = (sessions: Record<string, unknown>[]) => async (method: string) => {
  if (method === 'session.list') {
    return { sessions }
  }

  if (method === 'session.create') {
    return { session_id: 'run-1', stored_session_id: 'stored-1' }
  }

  return { applied: { ui_meta: true }, ok: true }
}

beforeEach(() => {
  request.mockReset()
  requestProfile.mockReset()
  openSession.mockReset().mockResolvedValue({ ok: true, storedSessionId: 'x' })
  agents.mockReset().mockResolvedValue({ agents: [], sources: [] })
  connections.mockReset().mockResolvedValue([])
  activeConnectionId.mockReset().mockReturnValue('local')
  notify.mockReset()
  notifyError.mockReset()
  $roster.set([])
  $rooms.set([])
})

describe('opening a bot chat', () => {
  it('OPENS the registry row rather than minting a second chat', async () => {
    request.mockImplementation(registry([{ id: 'existing', message_count: 3, title: 'Bot Chat' }]))

    const result = await openBotChat(row('radar') as never)

    expect(result).toMatchObject({ action: 'open', storedId: 'existing' })
    expect(calls('session.create')).toEqual([])
    // Identity is the title, so there is nothing durable to write down. The
    // click path must not touch the bot's record at all.
    expect(calls('profiles.configure')).toEqual([])
    expect(openSession).toHaveBeenCalledWith('existing', { expectHistory: true, profile: 'radar' })
  })

  it('asks the registry with include_hidden — a canonical chat is born hidden', async () => {
    request.mockImplementation(registry([{ id: 'existing', title: 'Bot Chat' }]))

    await openBotChat(row('radar') as never)

    expect(calls('session.list')[0]).toMatchObject({ include_hidden: true, title: 'Bot Chat' })
  })

  it('opens the live TIP when a compaction rotated the lineage', async () => {
    request.mockImplementation(
      registry([{ id: 'root', message_count: 9, resolved_id: 'tip', title: 'Bot Chat' }])
    )

    const result = await openBotChat(row('radar') as never)

    expect(result.storedId).toBe('tip')
    expect(openSession).toHaveBeenCalledWith('tip', { expectHistory: true, profile: 'radar' })
  })

  it('mints, TITLES the runtime id, then opens the durable one', async () => {
    // `session.create` persists nothing — the title write is what makes the row.
    // Without it the stored id addresses nothing and every later open 4007s.
    request.mockImplementation(registry([]))

    const result = await openBotChat(row('radar') as never)

    expect(result).toMatchObject({ action: 'create', storedId: 'stored-1' })
    expect(calls('session.create')[0]).toMatchObject({ hidden: true, title: 'Bot Chat' })
    expect(calls('session.title')[0]).toMatchObject({ session_id: 'run-1', title: 'Bot Chat' })
    // Expected-empty: a chat minted a moment ago has no transcript to wait for,
    // and waiting costs 40 seconds and then reports failure.
    expect(openSession).toHaveBeenCalledWith('stored-1', { expectHistory: false, profile: 'radar' })
  })

  it('does the three steps in order — create, title, open', async () => {
    request.mockImplementation(registry([]))

    await openBotChat(row('radar') as never)

    const order = (request.mock.calls as Call[]).map(([method]) => method).filter(m => m !== 'profiles.list')

    expect(order).toEqual(['session.list', 'session.create', 'session.title'])
  })

  it('never sends a kickoff message', async () => {
    // Universal has no New-Agent flow, and firing an intro from the CLICK path
    // burns a model turn and stamps a user-attributed greeting into the chat
    // every time a lookup misses.
    request.mockImplementation(registry([]))

    await openBotChat(row('radar') as never)

    expect(calls('prompt.submit')).toEqual([])
  })

  it('never claims an ORDINARY session an older gateway answered with', async () => {
    // A gateway that ignores the `title` param answers a normal listing.
    request.mockImplementation(registry([{ id: 'someones-work', title: 'Refactor the parser' }]))

    await openBotChat(row('radar') as never)

    expect(calls('session.create')).toHaveLength(1)
    expect(openSession).toHaveBeenCalledWith('stored-1', { expectHistory: false, profile: 'radar' })
  })

  it('ADOPTS the winner when another writer took the title first', async () => {
    // Two clients, one registry. The DB's unique title index picks the winner;
    // the loser must adopt it, never mint again.
    let asked = 0

    request.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        asked += 1

        return { sessions: asked === 1 ? [] : [{ id: 'theirs', message_count: 1, title: 'Bot Chat' }] }
      }

      if (method === 'session.create') {
        return { session_id: 'run-1', stored_session_id: 'stored-1' }
      }

      if (method === 'session.title') {
        throw new Error('4022 title already in use')
      }

      return { ok: true }
    })

    const result = await openBotChat(row('radar') as never)

    expect(result).toMatchObject({ storedId: 'theirs' })
    expect(calls('session.create')).toHaveLength(1)
    expect(openSession).toHaveBeenCalledWith('theirs', { expectHistory: true, profile: 'radar' })
  })

  it('refuses to mint TWICE when the second lookup still misses', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { sessions: [] }
      }

      if (method === 'session.create') {
        return { session_id: 'run-1', stored_session_id: 'stored-1' }
      }

      if (method === 'session.title') {
        throw new Error('4022 title already in use')
      }

      return { ok: true }
    })

    await openBotChat(row('radar') as never)

    expect(calls('session.create')).toHaveLength(1)
    expect(notifyError).toHaveBeenCalled()
  })

  it('refuses to mint when the registry did not ANSWER', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        throw new Error('gateway closed')
      }

      return { ok: true }
    })

    const result = await openBotChat(row('radar') as never)

    expect(result.action).toBe('unavailable')
    expect(calls('session.create')).toEqual([])
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('try again'))
  })

  it('is single-flight — a double tap makes ONE chat', async () => {
    request.mockImplementation(registry([]))

    await Promise.all([openBotChat(row('radar') as never), openBotChat(row('radar') as never)])

    expect(calls('session.create')).toHaveLength(1)
  })
})

describe('an open that fails', () => {
  it('reports it, and does not mint a replacement', async () => {
    request.mockImplementation(registry([{ id: 'existing', message_count: 2, title: 'Bot Chat' }]))
    openSession.mockResolvedValue({ error: 'exhausted', ok: false })

    const result = await openBotChat(row('radar') as never)

    expect(result).toMatchObject({ action: 'open', error: 'exhausted' })
    expect(calls('session.create')).toEqual([])
    expect(notifyError).toHaveBeenCalled()
  })

  it('says nothing when the user simply moved on mid-open', async () => {
    request.mockImplementation(registry([{ id: 'existing', title: 'Bot Chat' }]))
    openSession.mockResolvedValue({ error: 'superseded', ok: false })

    await openBotChat(row('radar') as never)

    expect(notifyError).not.toHaveBeenCalled()
  })
})

describe('the hidden-session sweep', () => {
  it('hides the registry row, and nothing it was not told about', async () => {
    request.mockImplementation(async (method: string, sent: Record<string, unknown>) => {
      if (method === 'session.list') {
        return sent.title === 'Bot Chat' ? { sessions: [{ id: 'chat-radar', title: 'Bot Chat' }] } : { sessions: [] }
      }

      return { ok: true }
    })
    $roster.set([row('radar')] as never)

    const swept = await sweepHiddenSessions()

    expect(calls('session.set_hidden')).toEqual([
      { hidden: true, profile: 'radar', session_id: 'chat-radar' }
    ])
    expect(swept).toMatchObject({ failed: 0, hidden: 1 })
  })

  it('touches NOTHING for a bot with no Bot Chat', async () => {
    // Where a stale pin used to fire a doomed set_hidden on every reconnect.
    request.mockImplementation(async (method: string) =>
      method === 'session.list' ? { sessions: [] } : { ok: true }
    )
    $roster.set([row('radar')] as never)

    expect(await sweepHiddenSessions()).toMatchObject({ failed: 0, hidden: 0 })
    expect(calls('session.set_hidden')).toEqual([])
  })

  it('refuses the row an OLD gateway answered a title query with', async () => {
    // A plain listing whose first row is the user's real work. Guard 2 reads
    // the title the GATEWAY reported, which is what closes this in the sweep
    // and not only in adoption.
    request.mockImplementation(async (method: string) =>
      method === 'session.list'
        ? { sessions: [{ id: 'someones-work', title: 'Refactor the parser' }] }
        : { ok: true }
    )
    $roster.set([row('radar')] as never)

    expect(await sweepHiddenSessions()).toMatchObject({ hidden: 0 })
    expect(calls('session.set_hidden')).toEqual([])
  })

  it('never sweeps a bot on another machine', async () => {
    request.mockImplementation(async () => ({ sessions: [{ id: 'x', title: 'Bot Chat' }] }))
    $roster.set([{ ...row('radar'), connectionId: 'c2', key: 'radar@c2' }] as never)

    await sweepHiddenSessions()

    expect(calls('session.set_hidden')).toEqual([])
  })

  it('reports a REFUSED hide as failed, not as hidden', async () => {
    request.mockImplementation(async (method: string, sent: Record<string, unknown>) => {
      if (method === 'session.list') {
        return { sessions: [{ id: `chat-${sent.profile}`, title: 'Bot Chat' }] }
      }

      if (method === 'session.set_hidden' && sent.session_id === 'chat-radar') {
        throw new Error('session not found')
      }

      return { ok: true }
    })
    $roster.set([row('radar'), row('scout')] as never)

    expect(await sweepHiddenSessions()).toEqual({ failed: 1, hidden: 1, skipped: 0 })
  })
})

describe('the roster', () => {
  it('is single-flight — three callers in one tick make ONE profiles.list', async () => {
    request.mockResolvedValue({ bot_mode_protocol: true, profiles: [profile('radar')] })

    await Promise.all([refreshRoster(), refreshRoster(), refreshRoster()])

    expect(calls('profiles.list')).toHaveLength(1)
  })

  it('rebuilds the rooms from the roster alone', async () => {
    request.mockResolvedValue({
      profiles: [
        profile('radar', {
          'hermes-bots': {
            rooms: [{ at: 1, id: 'r_a', members: [], name: 'Ops', rev: 1, session: 's-radar' }],
            v: 1
          }
        })
      ]
    })

    await refreshRoster()

    expect($rooms.get()).toHaveLength(1)
    expect($rooms.get()[0]).toMatchObject({ name: 'Ops', sessions: { radar: 's-radar' } })
  })

  it('keeps the last good roster when the call fails, rather than blanking it', async () => {
    request.mockResolvedValueOnce({ profiles: [profile('radar')] })
    await refreshRoster()

    request.mockRejectedValueOnce(new Error('gateway closed'))
    await refreshRoster()

    expect($roster.get().map(entry => entry.profile)).toEqual(['radar'])
  })

  it('still paints the local half when the remote registry refuses', async () => {
    agents.mockRejectedValue(new Error('AGENT_ROUTING_UNAVAILABLE'))
    request.mockResolvedValue({ profiles: [profile('radar')] })

    await refreshRoster()

    expect($roster.get().map(entry => entry.profile)).toEqual(['radar'])
  })

  it('drops the agents of a connection whose source came back BROKEN', async () => {
    // A missing row and a broken row are different facts: an agent on a machine
    // that is down must not look like an agent that does not exist, and it
    // certainly must not look reachable.
    agents.mockResolvedValue({
      agents: [
        { connectionId: 'c1', isDefault: false, label: 'owl', profile: 'owl' },
        { connectionId: 'c2', isDefault: false, label: 'ghost', profile: 'ghost' }
      ],
      sources: [
        { connectionId: 'c1', ok: true },
        { connectionId: 'c2', error: 'unreachable', ok: false }
      ]
    })
    connections.mockResolvedValue([{ id: 'c1', kind: 'ssh', label: 'Laptop', primary: false }])
    request.mockResolvedValue({ profiles: [profile('radar')] })

    await refreshRoster()

    expect($roster.get().map(entry => entry.profile).sort()).toEqual(['owl', 'radar'])
  })

  it('does NOT list the active connection twice, though the union reports it', async () => {
    // `host.agents()` enumerates EVERY registered connection including the one
    // this window is routed to, and `profiles.list` has already read that same
    // source richly. Merging both renders every profile twice — once bare, once
    // source-qualified — and the thin copy carries no `ui_meta`.
    agents.mockResolvedValue({
      agents: [
        { connectionId: 'remote-1', isDefault: true, label: 'default', profile: 'default' },
        { connectionId: 'remote-1', isDefault: false, label: 'radar', profile: 'radar' },
        { connectionId: 'c2', isDefault: false, label: 'owl', profile: 'owl' }
      ],
      sources: [
        { connectionId: 'remote-1', ok: true },
        { connectionId: 'c2', ok: true }
      ]
    })
    connections.mockResolvedValue([
      { id: 'remote-1', kind: 'remote', label: 'Server', primary: true },
      { id: 'c2', kind: 'remote', label: 'Laptop', primary: false }
    ])
    request.mockResolvedValue({ profiles: [profile('default'), profile('radar')] })

    await refreshRoster()

    const roster = $roster.get()

    expect(roster.map(entry => entry.profile).sort()).toEqual(['default', 'owl', 'radar'])
    // Bare, because nothing collides once the echo is gone. A surviving echo
    // would force `@radar-server` onto the user's own agent.
    expect(roster.filter(entry => entry.profile === 'radar').map(entry => entry.handle)).toEqual(['radar'])
    // The surviving local rows are the RICH ones — the thin copy is what makes
    // a click destroy the record.
    expect(roster.find(entry => entry.profile === 'radar')?.metaKnown).toBe(true)
  })

  it('falls back to the active connection id when no registry row is flagged primary', async () => {
    activeConnectionId.mockReturnValue('remote-1')
    agents.mockResolvedValue({
      agents: [{ connectionId: 'remote-1', isDefault: false, label: 'radar', profile: 'radar' }],
      sources: [{ connectionId: 'remote-1', ok: true }]
    })
    connections.mockResolvedValue([{ id: 'remote-1', kind: 'remote', label: 'Server', primary: false }])
    request.mockResolvedValue({ profiles: [profile('radar')] })

    await refreshRoster()

    expect($roster.get().map(entry => entry.profile)).toEqual(['radar'])
  })
})

describe('a bot on another machine', () => {
  it('REFUSES to open its chat here, and says how to reach it instead', async () => {
    // Every session door takes a profile and no connection, so resuming a
    // remote id against this gateway is a guaranteed 4007 — and `openSession`
    // would first repoint the ACTIVE profile at a name this backend lacks.
    const remote = { ...row('radar'), connectionId: 'c2', key: 'radar@c2', metaKnown: false }

    const result = await openBotChat(remote as never)

    expect(result.action).toBe('remote')
    expect(openSession).not.toHaveBeenCalled()
    expect(calls('session.list')).toEqual([])
    expect(requestProfile).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('@radar') })
    )
  })
})

describe('writing a bot record', () => {
  it('REFUSES a write for a row whose ui_meta was never read, and says so', async () => {
    // `profiles.configure` merges `ui_meta` key-wise, so a write built on an
    // empty meta REPLACES the whole `hermes-bots` value — title, `hidden`, and
    // every room membership. A names-only source cannot tell "no record" from
    // "not read", so the write is refused.
    const thin = { ...row('radar'), connectionId: 'c2', key: 'radar@c2', metaKnown: false }

    const outcome = await saveBotMeta(thin as never, { hidden: true })

    expect(outcome).toBe('unsafe')
    expect(calls('profiles.configure')).toEqual([])
    expect(requestProfile).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalled()
  })

  it('writes normally for a row that DID carry a record', async () => {
    request.mockResolvedValue({ applied: { ui_meta: true }, ok: true })

    const outcome = await saveBotMeta(row('radar', { title: 'Sentinel' }) as never, {
      hidden: true,
      title: 'Sentinel'
    })

    expect(outcome).toBe('persisted')
    expect(calls('profiles.configure')[0]).toMatchObject({
      name: 'radar',
      ui_meta: { 'hermes-bots': expect.objectContaining({ hidden: true, title: 'Sentinel' }) }
    })
  })

  it('reports an over-cap refusal instead of retrying it forever', async () => {
    // The backend refuses past 64 KB.
    request.mockResolvedValue({ applied: { ui_meta: false }, ok: true })

    await saveBotMeta(row('radar') as never, { hidden: true })

    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('full'))
  })

  it('says nothing when an OLDER gateway cannot report per-section results', async () => {
    // No `applied` at all: unsupported, not failed.
    request.mockResolvedValue({ ok: true })

    expect(await saveBotMeta(row('radar') as never, { hidden: true })).toBe('unsupported')
    expect(notifyError).not.toHaveBeenCalled()
  })
})
