/**
 * Cross-machine DM delivery — the id-space rule.
 *
 * `prompt.submit` resolves through the gateway's LIVE runtime map, so it takes
 * a runtime session key, never a stored id. A canonical Bot Chat is almost
 * never already running, which made a stored id here `session not found` most
 * of the time rather than occasionally.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { bindSession, requestProfile } = vi.hoisted(() => ({
  bindSession: vi.fn(),
  requestProfile: vi.fn()
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  host: {
    bindSession,
    request: vi.fn(),
    requestProfile,
    state: { liveSessions: { get: () => ({}) } }
  },
  livePollIntervalMs: (legacy: number) => legacy
}))

import { sendRemoteDm } from './remote'

const target = { connectionId: 'c2', profile: 'radar' }

const params = (method: string): Record<string, unknown>[] =>
  (requestProfile.mock.calls as [unknown, string, Record<string, unknown>][])
    .filter(([, name]) => name === method)
    .map(([, , sent]) => sent)

beforeEach(() => {
  bindSession.mockReset().mockResolvedValue({ messages: [], ok: true, sessionKey: 'runtime-77' })
  requestProfile.mockReset().mockImplementation(async (_route: unknown, method: string) => {
    if (method === 'profiles.list') {
      return { profiles: [{ name: 'radar', ui_meta: { 'hermes-bots': { chat: 'stored-1', v: 1 } } }] }
    }

    if (method === 'session.list') {
      return { sessions: [{ id: 'stored-1', title: 'Bot Chat' }] }
    }

    return { ok: true }
  })
})

describe('sending a DM to a bot on another machine', () => {
  it('submits against the RUNTIME key the bind returned, not the stored id', async () => {
    const result = await sendRemoteDm(target, 'scout', 'ship it')

    expect(result).toMatchObject({ ok: true, storedId: 'stored-1' })
    expect(bindSession).toHaveBeenCalledWith('stored-1', { profile: 'radar' })
    expect(params('prompt.submit')[0]).toMatchObject({ session_id: 'runtime-77' })
  })

  it('titles the runtime id and pins the DURABLE one when it has to mint', async () => {
    requestProfile.mockImplementation(async (_route: unknown, method: string) => {
      if (method === 'profiles.list') {
        return { profiles: [{ name: 'radar' }] }
      }

      if (method === 'session.list') {
        return { sessions: [] }
      }

      if (method === 'session.create') {
        return { session_id: 'run-9', stored_session_id: 'stored-9' }
      }

      return { ok: true }
    })

    const result = await sendRemoteDm(target, 'scout', 'ship it')

    expect(result).toMatchObject({ ok: true, storedId: 'stored-9' })
    expect(params('session.title')[0]).toMatchObject({ session_id: 'run-9', title: 'Bot Chat' })
    // The pin, the bind and the submit all use the durable id — never `run-9`.
    expect(params('profiles.configure')[0]).toMatchObject({
      ui_meta: { 'hermes-bots': expect.objectContaining({ chat: 'stored-9' }) }
    })
    expect(bindSession).toHaveBeenCalledWith('stored-9', { profile: 'radar' })
  })

  it('reports a chat it could not wake, rather than submitting into nothing', async () => {
    bindSession.mockResolvedValue({ error: 'gateway said no', ok: false })

    const result = await sendRemoteDm(target, 'scout', 'ship it')

    expect(result).toMatchObject({ ok: false, reason: 'no-chat' })
    expect(params('prompt.submit')).toEqual([])
  })
})
