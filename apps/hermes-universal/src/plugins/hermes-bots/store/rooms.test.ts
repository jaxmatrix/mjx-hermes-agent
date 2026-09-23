/**
 * Room replication's HONESTY property.
 *
 * A room record is replicated onto every member's profile, and a member whose
 * write did not land has no copy of the room. What is pinned here is that such
 * a member is REPORTED — including when the refusal is local (`unsafe`, the
 * guard against emptying a bot's record), which is the case a plain
 * `outcome === 'rejected'` check counts as success.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { confirm, holdKeepAwake, notifyError, request, requestProfile } = vi.hoisted(() => ({
  confirm: vi.fn(),
  holdKeepAwake: vi.fn(() => () => {}),
  notifyError: vi.fn(),
  request: vi.fn(),
  requestProfile: vi.fn()
}))

// PARTIAL, like `store/bots.test.ts`: the real SDK still supplies `atom`, so
// every store in the tree keeps sharing one nanostore.
vi.mock('@hermes/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirm,
  holdKeepAwake,
  host: {
    activeConnectionId: () => 'local',
    agents: vi.fn(async () => ({ agents: [], sources: [] })),
    connections: vi.fn(async () => []),
    notifyError,
    request,
    requestProfile,
    state: { liveSessions: { get: () => ({}) } }
  },
  livePollIntervalMs: (legacy: number) => legacy
}))

import { $rooms, $roster } from './atoms'
import { createRoom } from './rooms'

const row = (name: string, metaKnown: boolean, connectionId?: string) => ({
  ...(connectionId ? { connectionId } : {}),
  description: '',
  handle: name,
  hasAvatar: false,
  isDefault: false,
  key: connectionId ? `${name}@${connectionId}` : name,
  lastActive: 0,
  meta: {},
  metaKnown,
  model: null,
  name,
  preview: '',
  profile: name,
  working: false
})

beforeEach(() => {
  request.mockReset().mockImplementation(async (method: string) => {
    if (method === 'session.create') {
      const n = Math.random().toString(16).slice(2, 8)

      return { session_id: `run-${n}`, stored_session_id: `stored-${n}` }
    }

    return { applied: { ui_meta: true }, ok: true }
  })
  notifyError.mockReset()
  requestProfile.mockReset().mockImplementation(async (_route: unknown, method: string) =>
    method === 'session.create' ? { session_id: 's-remote' } : { applied: { ui_meta: true }, ok: true }
  )
  $roster.set([])
  $rooms.set([])
})

describe('replicating a room to its members', () => {
  it('REPORTS a member whose record could not be written, rather than counting it as done', async () => {
    // `radar`'s row came from a names-only source, so its `meta` was never
    // read and `saveBotMeta` refuses. The room still exists for `scout`; a
    // silent success here is how a room half-exists with nothing said.
    const members = [row('scout', true), row('radar', false, 'c2')]

    $roster.set(members as never)

    const room = await createRoom('Ops', members as never)

    expect(room).not.toBeNull()
    expect(notifyError).toHaveBeenCalledWith(
      expect.any(Error),
      'Some agents did not accept the room change'
    )
    expect((notifyError.mock.calls[0][0] as Error).message).toContain('radar')
  })

  it('records the DURABLE id and titles the RUNTIME one, so the row exists at all', async () => {
    // `session.create` persists nothing; the title write is what makes the row.
    // Recording `session_id` (a runtime handle) left every member session
    // unresumable and unbindable.
    const members = [row('scout', true)]

    $roster.set(members as never)

    const room = await createRoom('Ops', members as never)

    const recorded = room?.sessions.scout ?? ''

    expect(recorded).toMatch(/^stored-/)

    const titled = (request.mock.calls as [string, Record<string, unknown>][]).filter(
      ([method]) => method === 'session.title'
    )

    expect(titled).toHaveLength(1)
    expect(titled[0][1]).toMatchObject({ session_id: expect.stringMatching(/^run-/), title: 'Group: Ops' })
  })

  it('says nothing when every member accepted', async () => {
    const members = [row('scout', true), row('owl', true)]

    $roster.set(members as never)

    await createRoom('Ops', members as never)

    expect(notifyError).not.toHaveBeenCalled()
  })
})
