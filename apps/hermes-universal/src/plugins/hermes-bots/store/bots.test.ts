/**
 * The roster's EFFECTS: the canonical-chat ladder as it actually calls the
 * gateway, and the hide sweep's two guards.
 *
 * The decisions are already pinned in `model/canonical.test.ts`; what is pinned
 * here is that the store executes them — that an adopt really does write the
 * pin, that a create really does mint before opening, and above all that the
 * sweep never asks the gateway to hide a session it does not own.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { agents, connections, notifyError, openSession, request, requestProfile } = vi.hoisted(() => ({
  agents: vi.fn(),
  connections: vi.fn(),
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
    agents,
    connections,
    notifyError,
    openSession,
    request,
    requestProfile,
    state: { liveSessions: { get: () => ({}) } }
  },
  livePollIntervalMs: (legacy: number) => legacy
}))

import { $rooms, $roster } from './atoms'
import { openBotChat, refreshRoster, sweepHiddenSessions } from './bots'

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
  model: null,
  name,
  preview: '',
  profile: name,
  working: false
})

beforeEach(() => {
  request.mockReset()
  requestProfile.mockReset()
  openSession.mockReset().mockResolvedValue({ ok: true, storedSessionId: 'x' })
  agents.mockReset().mockResolvedValue({ agents: [], sources: [] })
  connections.mockReset().mockResolvedValue([])
  notifyError.mockReset()
  $roster.set([])
  $rooms.set([])
})

describe('opening a bot chat', () => {
  it('ADOPTS an existing hidden Bot Chat and pins it, rather than minting a second', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { sessions: [{ id: 'existing', title: 'Bot Chat' }] }
      }

      return { applied: { ui_meta: true }, ok: true }
    })

    const result = await openBotChat(row('radar') as never)

    expect(result.action).toBe('adopt')
    expect(calls('session.create')).toEqual([])
    // The pin is written, so the NEXT open resumes rather than looking again.
    expect(calls('profiles.configure')[0]).toMatchObject({
      name: 'radar',
      ui_meta: { 'hermes-bots': expect.objectContaining({ chat: 'existing' }) }
    })
    expect(openSession).toHaveBeenCalledWith('existing', { profile: 'radar' })
  })

  it('mints a HIDDEN, titled session when there is nothing to adopt', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { sessions: [] }
      }

      if (method === 'session.create') {
        return { session_id: 'fresh' }
      }

      return { applied: { ui_meta: true }, ok: true }
    })

    const result = await openBotChat(row('radar') as never)

    expect(result).toMatchObject({ action: 'create', storedId: 'fresh' })
    expect(calls('session.create')[0]).toMatchObject({ hidden: true, title: 'Bot Chat' })
  })

  it('never claims an ORDINARY session an older gateway answered with', async () => {
    // A gateway that ignores the `title` param answers a normal listing.
    request.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { sessions: [{ id: 'someones-work', title: 'Refactor the parser' }] }
      }

      if (method === 'session.create') {
        return { session_id: 'fresh' }
      }

      return { applied: { ui_meta: true }, ok: true }
    })

    await openBotChat(row('radar') as never)

    expect(calls('session.create')).toHaveLength(1)
    expect(openSession).toHaveBeenCalledWith('fresh', { profile: 'radar' })
  })

  it('opens the live TIP of a rotated pin while keeping the durable pin', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { sessions: [{ id: 'root', resolved_id: 'tip', title: 'Bot Chat' }] }
      }

      return { applied: { ui_meta: true }, ok: true }
    })

    const result = await openBotChat(row('radar', { chat: 'root' }) as never)

    expect(result.action).toBe('resume-tip')
    expect(openSession).toHaveBeenCalledWith('tip', { profile: 'radar' })
    // The pin was NOT rewritten to the tip — aliasing is core's job (rule 17).
    expect(calls('profiles.configure')).toEqual([])
  })

  it('keeps the pin through a lookup that FAILED, instead of forking the chat', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        throw new Error('gateway closed')
      }

      return { applied: { ui_meta: true }, ok: true }
    })

    const result = await openBotChat(row('radar', { chat: 'pinned' }) as never)

    expect(result.action).toBe('resume')
    expect(calls('session.create')).toEqual([])
    expect(openSession).toHaveBeenCalledWith('pinned', { profile: 'radar' })
  })
})

describe('writing the bot record', () => {
  it('reports an over-cap refusal instead of retrying it forever', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { sessions: [{ id: 'existing', title: 'Bot Chat' }] }
      }

      // The backend refuses past 64 KB.
      return { applied: { ui_meta: false }, ok: true }
    })

    await openBotChat(row('radar') as never)

    expect(calls('profiles.configure')).toHaveLength(1)
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('full'))
  })

  it('says nothing when an OLDER gateway simply cannot report per-section results', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { sessions: [{ id: 'existing', title: 'Bot Chat' }] }
      }

      // No `applied` at all: unsupported, not failed.
      return { ok: true }
    })

    await openBotChat(row('radar') as never)

    expect(notifyError).not.toHaveBeenCalled()
  })
})

describe('the hidden-session sweep', () => {
  it('hides every session this plugin owns — pins AND room member sessions', async () => {
    request.mockResolvedValue({})
    $roster.set([row('radar', { chat: 'chat-radar' }), row('scout', { chat: 'chat-scout' })] as never)
    $rooms.set([
      {
        at: 0,
        id: 'r_a',
        members: [],
        name: 'Ops',
        rev: 1,
        sessions: { radar: 'group-radar', scout: 'group-scout' }
      }
    ] as never)

    await sweepHiddenSessions()

    expect(calls('session.set_hidden').map(params => params.session_id).sort()).toEqual([
      'chat-radar',
      'chat-scout',
      'group-radar',
      'group-scout'
    ])
    expect(calls('session.set_hidden').every(params => params.hidden === true)).toBe(true)
  })

  it('touches NOTHING for a bot with no pin — an ordinary session is never hidden', async () => {
    // `session.set_hidden` flips a session's whole compression lineage: a wrong
    // call buries a real conversation and every ancestor of it.
    request.mockResolvedValue({})
    $roster.set([row('radar')] as never)

    await sweepHiddenSessions()

    expect(calls('session.set_hidden')).toEqual([])
  })

  it('skips a member session whose bot is not in the roster', async () => {
    request.mockResolvedValue({})
    $roster.set([row('radar', { chat: 'chat-radar' })] as never)
    $rooms.set([
      { at: 0, id: 'r_a', members: [], name: 'Ops', rev: 1, sessions: { ghost: 'group-ghost' } }
    ] as never)

    await sweepHiddenSessions()

    expect(calls('session.set_hidden').map(params => params.session_id)).toEqual(['chat-radar'])
  })

  it('is idempotent, and one failure does not abort the rest', async () => {
    request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'session.set_hidden' && params.session_id === 'chat-radar') {
        throw new Error('gone')
      }

      return {}
    })

    $roster.set([row('radar', { chat: 'chat-radar' }), row('scout', { chat: 'chat-scout' })] as never)

    await sweepHiddenSessions()
    await sweepHiddenSessions()

    expect(calls('session.set_hidden').filter(params => params.session_id === 'chat-scout')).toHaveLength(2)
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
})
