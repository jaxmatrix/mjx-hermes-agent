/**
 * The gateway hand-parses `params` and answers a bare 4000-series error when a
 * key is spelled wrong, so these tests pin the FRAME each helper puts on the
 * wire — key for key — against the handlers in tui_gateway/.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn() }))

import { GatewayRpcError } from '@/gateway/rpc-error'
import { requestGateway } from '@/store/gateway'

import {
  addMcpServer,
  clearProfileAsset,
  configureProfile,
  createCronJobRpc,
  createProfileRpc,
  describeProfile,
  discoverRepos,
  feedWakeAudio,
  findSessionByTitle,
  getProfileAsset,
  installAgentPlugin,
  isMissingRpcMethod,
  listCronJobsRpc,
  listMcpCatalog,
  listMcpServersForProfile,
  listProfilesRich,
  moveSessionWorkspace,
  pollMcpServerOAuth,
  reactToMessage,
  removeMcpServer,
  respondMcpSetup,
  respondPreviewAct,
  respondPreviewRead,
  respondTour,
  respondWindowRead,
  setMcpServerApiKey,
  setProfileAsset,
  setSessionHidden,
  startMcpServerOAuth,
  steerSubagent,
  testMcpServerForProfile,
  updateCronJobStateRpc,
  WAKE_FEED_SAMPLE_RATE
} from './gateway-rpc'

const rpc = vi.mocked(requestGateway)

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({})
})

/** The params of the single call made. */
const sentParams = () => rpc.mock.calls[0]?.[1]

describe('message.react', () => {
  it('addresses a persisted row by row_id and defaults the author to the user', async () => {
    await reactToMessage({ sessionId: 's1', target: { row_id: 42 }, emoji: '👍' })

    expect(rpc).toHaveBeenCalledWith('message.react', {
      session_id: 's1',
      row_id: 42,
      emoji: '👍',
      author: 'user'
    })
  })

  it('addresses a LIVE message by newest_role instead, since it has no row id yet', async () => {
    await reactToMessage({ sessionId: 's1', target: { newest_role: 'assistant' }, emoji: '❤️', author: 'agent' })

    expect(sentParams()).toEqual({
      session_id: 's1',
      newest_role: 'assistant',
      emoji: '❤️',
      author: 'agent'
    })
  })

  it('sends a literal null emoji to clear — not an omitted key, which the backend reads as "no change"', async () => {
    await reactToMessage({ sessionId: 's1', target: { row_id: 7 }, emoji: null })

    expect(sentParams()).toMatchObject({ emoji: null })
    expect(Object.keys(sentParams() as object)).toContain('emoji')
  })

  it('returns the row the backend resolved plus its authoritative reaction list', async () => {
    rpc.mockResolvedValue({ row_id: 9, reactions: [{ emoji: '👍', author: 'user', at: 1 }] })

    await expect(reactToMessage({ sessionId: 's1', target: { newest_role: 'user' }, emoji: '👍' })).resolves.toEqual({
      row_id: 9,
      reactions: [{ emoji: '👍', author: 'user', at: 1 }]
    })
  })
})

describe('preview/window read respond', () => {
  it('answers a preview read with request_id + text', async () => {
    rpc.mockResolvedValue({ status: 'ok' })

    await expect(respondPreviewRead('req-1', '{"text":"hi"}')).resolves.toEqual({ status: 'ok' })
    expect(rpc).toHaveBeenCalledWith('preview.read.respond', { request_id: 'req-1', text: '{"text":"hi"}' })
  })

  it('answers a window read on its own method', async () => {
    await respondWindowRead('req-2', '')

    expect(rpc).toHaveBeenCalledWith('window.read.respond', { request_id: 'req-2', text: '' })
  })

  it('treats an expired answer as a normal result, not a rejection', async () => {
    rpc.mockResolvedValue({ status: 'expired' })

    await expect(respondWindowRead('req-3', '{}')).resolves.toEqual({ status: 'expired' })
  })
})

describe('session.workspace.move', () => {
  it('sends the STORED session_key and cwd, omitting profile when unset', async () => {
    await moveSessionWorkspace({ sessionKey: 'sess-abc', cwd: '/repo/app' })

    expect(sentParams()).toEqual({ cwd: '/repo/app', session_key: 'sess-abc' })
  })

  it('threads a profile through when one is given', async () => {
    await moveSessionWorkspace({ sessionKey: 'sess-abc', cwd: '/repo/app', profile: 'work' })

    expect(sentParams()).toEqual({ cwd: '/repo/app', session_key: 'sess-abc', profile: 'work' })
  })

  it('returns the resolved cwd plus the REPLACED git identity', async () => {
    rpc.mockResolvedValue({ cwd: '/repo/app', branch: 'main', git_repo_root: '/repo' })

    await expect(moveSessionWorkspace({ sessionKey: 's', cwd: '~/repo/app' })).resolves.toEqual({
      cwd: '/repo/app',
      branch: 'main',
      git_repo_root: '/repo'
    })
  })
})

describe('subagent.steer', () => {
  it('sends the invoking session alongside the child id and text', async () => {
    rpc.mockResolvedValue({ status: 'queued', subagent_id: 'sub-1', text: 'focus on pricing' })

    await steerSubagent({ sessionId: 's1', subagentId: 'sub-1', text: 'focus on pricing' })

    expect(rpc).toHaveBeenCalledWith('subagent.steer', {
      session_id: 's1',
      subagent_id: 'sub-1',
      text: 'focus on pricing'
    })
  })

  it('surfaces a refusal as a RESOLVED rejected status — the backend never errors for it', async () => {
    rpc.mockResolvedValue({ status: 'rejected', subagent_id: 'sub-1', text: 'too late' })

    await expect(steerSubagent({ sessionId: 's1', subagentId: 'sub-1', text: 'too late' })).resolves.toMatchObject({
      status: 'rejected'
    })
  })
})

describe('wake.feed', () => {
  it('sends base64 pcm at 16 kHz with a short timeout so a stalled socket cannot pile up frames', async () => {
    rpc.mockResolvedValue({ fed: true, reason: null })

    await feedWakeAudio('AAECAw==')

    expect(rpc).toHaveBeenCalledWith(
      'wake.feed',
      { pcm: 'AAECAw==', sample_rate: WAKE_FEED_SAMPLE_RATE },
      expect.any(Number)
    )
    expect(rpc.mock.calls[0]?.[2]).toBeLessThan(120_000)
  })

  it('reports a frame the detector refused because another transport owns it', async () => {
    rpc.mockResolvedValue({ fed: false, reason: 'not_owner' })

    await expect(feedWakeAudio('AAA=')).resolves.toEqual({ fed: false, reason: 'not_owner' })
  })
})

describe('isMissingRpcMethod', () => {
  it('recognises every spelling a gateway uses for an unknown method', () => {
    for (const message of ['Method not found', 'rpc error -32601', 'unknown method: wake.feed', 'no such method']) {
      expect(isMissingRpcMethod(new Error(message))).toBe(true)
    }
  })

  it('does not swallow a real failure', () => {
    expect(isMissingRpcMethod(new Error('session busy'))).toBe(false)
    expect(isMissingRpcMethod('gateway not connected')).toBe(false)
  })

  it('believes the -32601 code even when the prose is one we would not recognise', () => {
    // The gateway says "unknown method: X" today. It is the only emitter of
    // -32601 (tui_gateway/server.py handle_request), but the prose is not a
    // contract and a proxy in front of it never promised our four spellings.
    expect(isMissingRpcMethod(new GatewayRpcError('the requested procedure does not exist', -32601))).toBe(true)
  })

  it('does not read a nested -32601 in a real failure as an old backend', () => {
    // A handler that fails because something IT called answered -32601 (an MCP
    // server behind a tool does exactly this) comes back under the handler's
    // own code with the nested error quoted in the message. Prose alone read
    // that as "this backend predates the method" and latched surfaces —
    // projects, the pet gallery — into a degraded mode for the whole session.
    const nested = new GatewayRpcError('tool failed: McpError(-32601 Method not found)', 5061)

    expect(isMissingRpcMethod(nested)).toBe(false)
  })

  it('still reads the message when the rejection carries no code', () => {
    // Not every rejection comes off the wire: a locally constructed Error, or a
    // frame with no `code` at all.
    expect(isMissingRpcMethod(new GatewayRpcError('unknown method: pet.gallery', null))).toBe(true)
    expect(isMissingRpcMethod(new GatewayRpcError('session busy', null))).toBe(false)
  })
})

// --- The 2026-08-18 / 2026-08-20 sync (MJXHRM-444) -------------------------
//
// Every handler in this wave takes an OPTIONAL `profile` that scopes
// HERMES_HOME around it. Omitting the key is "the launch profile"; sending
// `profile: null` or `profile: ''` is a different frame, and the point of these
// tests is that a helper called without one is byte-identical to the pre-wave
// call an existing surface already makes.

describe('optional profile scoping', () => {
  it.each([
    ['mcp.catalog', () => listMcpCatalog()],
    ['mcp.servers.list', () => listMcpServersForProfile()],
    ['projects.discover_repos', () => discoverRepos()],
    ['cron.manage', () => listCronJobsRpc()]
  ])('omits the profile key entirely for %s when none is given', async (method, call) => {
    await call()

    expect(rpc.mock.calls[0][0]).toBe(method)
    expect(Object.keys(sentParams() as object)).not.toContain('profile')
  })

  it.each([
    ['an empty string', ''],
    ['null', null],
    ['whitespace', '   ']
  ])('omits it for %s too, rather than sending a value the backend reads as a lookup', async (_label, profile) => {
    await listMcpServersForProfile(profile)

    expect(Object.keys(sentParams() as object)).not.toContain('profile')
  })

  it('sends a real profile through, trimmed', async () => {
    await listMcpServersForProfile('  research  ')

    expect(sentParams()).toEqual({ profile: 'research' })
  })
})

describe('mcp.servers.*', () => {
  it('adds a preset-backed server, keeping the bearer token out of the config entry', async () => {
    await addMcpServer({ name: 'linear', preset: 'linear', bearerToken: 'sk-live', profile: 'work' })

    expect(rpc).toHaveBeenCalledWith('mcp.servers.add', {
      name: 'linear',
      profile: 'work',
      preset: 'linear',
      // The secret rides its OWN key so the backend can write it to .env and
      // persist only the Authorization template. Folding it into `config`
      // would put the live token in config.yaml.
      bearer_token: 'sk-live'
    })
    expect(sentParams()).not.toHaveProperty('config')
  })

  it('adds a config-backed server', async () => {
    await addMcpServer({ name: 'fs', config: { command: 'npx', args: ['-y', 'server-fs'] } })

    expect(sentParams()).toEqual({ name: 'fs', config: { command: 'npx', args: ['-y', 'server-fs'] } })
  })

  it('sends the secret and lets the backend pick the env key when none is named', async () => {
    await setMcpServerApiKey({ name: 'brave', value: 'secret' })

    expect(sentParams()).toEqual({ name: 'brave', value: 'secret' })
  })

  it('names the env key when the caller pinned one', async () => {
    await setMcpServerApiKey({ name: 'brave', value: 'secret', envVar: 'BRAVE_KEY' })

    expect(sentParams()).toMatchObject({ env_var: 'BRAVE_KEY' })
  })

  it('surfaces a FAILED probe as a resolved value, not a rejection', async () => {
    rpc.mockResolvedValue({ ok: false, error: 'ECONNREFUSED', tools: [], oauth_needed: false })

    await expect(testMcpServerForProfile('fs')).resolves.toMatchObject({ ok: false, error: 'ECONNREFUSED' })
  })

  it('removes by name', async () => {
    await removeMcpServer('fs', 'work')

    expect(rpc).toHaveBeenCalledWith('mcp.servers.remove', { name: 'fs', profile: 'work' })
  })

  it('polls a flow by BOTH the server name and the session id — the id alone carries no profile scope', async () => {
    await startMcpServerOAuth('notion')
    await pollMcpServerOAuth({ name: 'notion', sessionId: 'flow-1', profile: 'work' })

    expect(rpc.mock.calls[0]).toEqual(['mcp.servers.oauth.start', { name: 'notion' }])
    expect(rpc.mock.calls[1]).toEqual([
      'mcp.servers.oauth.poll',
      { name: 'notion', session_id: 'flow-1', profile: 'work' }
    ])
  })
})

describe('the responder family', () => {
  // `_respond(rid, params, "result", ...)` — every sibling responder reads
  // `text`, and this one does not. Sending `text` here is a silent no-answer
  // that leaves the setup tool blocked for its full ten minutes.
  it('answers mcp.setup.respond under `result`, not `text`', async () => {
    await respondMcpSetup('req-1', { status: 'installed', server: 'notion' })

    expect(rpc).toHaveBeenCalledWith('mcp.setup.respond', {
      request_id: 'req-1',
      result: JSON.stringify({ status: 'installed', server: 'notion' })
    })
    expect(sentParams()).not.toHaveProperty('text')
  })

  it('answers preview.act.respond and tour.respond under `text`', async () => {
    await respondPreviewAct('req-2', '{"url":"about:blank"}')
    await respondTour('req-3', '{"matched":0}')

    expect(rpc.mock.calls[0]).toEqual(['preview.act.respond', { request_id: 'req-2', text: '{"url":"about:blank"}' }])
    expect(rpc.mock.calls[1]).toEqual(['tour.respond', { request_id: 'req-3', text: '{"matched":0}' }])
  })
})

describe('profiles.*', () => {
  it('asks for the cheap roster without the per-profile state.db reads', async () => {
    await listProfilesRich({ includeSessions: false })

    expect(rpc).toHaveBeenCalledWith('profiles.list', { include_sessions: false })
  })

  it('sends no flags at all by default, so the backend defaults stand', async () => {
    await listProfilesRich()

    expect(sentParams()).toEqual({})
  })

  it('carries pinned session ids so the preview and the click target agree', async () => {
    await listProfilesRich({ preferredSessionIds: { scout: 'sess-9' } })

    expect(sentParams()).toEqual({ preferred_session_ids: { scout: 'sess-9' } })
  })

  it('creates without pinning mirror_credentials, whose backend default keeps the profile usable', async () => {
    await createProfileRpc({ name: 'scout', description: 'recon' })

    expect(sentParams()).toEqual({ name: 'scout', description: 'recon' })
  })

  it('sends an explicit mirror_credentials: false through — it is not the same as omitting it', async () => {
    await createProfileRpc({ name: 'scout', mirrorCredentials: false })

    expect(sentParams()).toEqual({ name: 'scout', mirror_credentials: false })
  })

  it('describes by name', async () => {
    await describeProfile('scout')

    expect(rpc).toHaveBeenCalledWith('profiles.describe', { name: 'scout' })
  })

  // Every list field is REPLACE semantics, so an EMPTY list is a real
  // instruction ("clear the toolset pin"), not an absent one. A helper that
  // dropped falsy values would make that unsendable.
  it('sends an empty list rather than dropping it — an empty enabled_toolsets clears the pin', async () => {
    await configureProfile({ name: 'scout', enabledToolsets: [] })

    expect(sentParams()).toEqual({ name: 'scout', enabled_toolsets: [] })
  })

  it('sends an empty soul/description string too, which is how a field is cleared', async () => {
    await configureProfile({ name: 'scout', soul: '', description: '' })

    expect(sentParams()).toEqual({ name: 'scout', soul: '', description: '' })
  })

  it('omits every section the caller did not touch, so a partial Save cannot blank the rest', async () => {
    await configureProfile({ name: 'scout', model: 'gpt-5', provider: 'openai' })

    expect(sentParams()).toEqual({ name: 'scout', model: 'gpt-5', provider: 'openai' })
  })

  it('defaults the asset kind to avatar on both halves', async () => {
    await setProfileAsset({ name: 'scout', data: 'data:image/png;base64,AAA' })
    await getProfileAsset('scout')

    expect(rpc.mock.calls[0][1]).toMatchObject({ asset: 'avatar' })
    expect(rpc.mock.calls[1][1]).toEqual({ name: 'scout', asset: 'avatar' })
  })

  // The backend keys on `clear` and ignores `data` entirely when it is set, so
  // a clear must never ride the same call as a write.
  it('clears with the flag and no data', async () => {
    await clearProfileAsset('scout')

    expect(rpc).toHaveBeenCalledWith('profiles.set_asset', { name: 'scout', asset: 'avatar', clear: true })
    expect(sentParams()).not.toHaveProperty('data')
  })
})

describe('session.set_hidden / session.list', () => {
  it('sends the hidden flag explicitly in both directions', async () => {
    await setSessionHidden({ sessionId: 's1', hidden: false })

    expect(rpc).toHaveBeenCalledWith('session.set_hidden', { session_id: 's1', hidden: false })
    // Omitting it would let the backend default to TRUE and hide a session the
    // caller was trying to reveal.
    expect(Object.keys(sentParams() as object)).toContain('hidden')
  })

  it('looks a session up by exact title', async () => {
    await findSessionByTitle({ title: 'Bot Chat', profile: 'scout' })

    expect(rpc).toHaveBeenCalledWith('session.list', { title: 'Bot Chat', profile: 'scout' })
  })

  it('answers an empty list for no match — not an error a caller has to catch', async () => {
    rpc.mockResolvedValue({ sessions: [] })

    await expect(findSessionByTitle({ title: 'nope' })).resolves.toEqual({ sessions: [] })
  })
})

describe('projects.discover_repos', () => {
  it('omits `scan` unless asked — a client-side scan is the default and this one walks the backend disk', async () => {
    await discoverRepos({ profile: 'work' })

    expect(sentParams()).toEqual({ profile: 'work' })
  })

  it('sends scan: true when the backend must walk its own roots', async () => {
    await discoverRepos({ profile: 'work', scan: true })

    expect(sentParams()).toEqual({ profile: 'work', scan: true })
  })
})

describe('plugins.manage install', () => {
  it('installs by identifier, leaving force and enable to their backend defaults', async () => {
    await installAgentPlugin({ identifier: 'owner/repo' })

    expect(rpc).toHaveBeenCalledWith('plugins.manage', { action: 'install', identifier: 'owner/repo' })
  })

  it('sends an explicit enable: false — the backend default is true', async () => {
    await installAgentPlugin({ identifier: 'owner/repo', enable: false, force: true, profile: 'work' })

    expect(sentParams()).toEqual({
      action: 'install',
      identifier: 'owner/repo',
      profile: 'work',
      force: true,
      enable: false
    })
  })
})

describe('cron.manage', () => {
  it('omits include_disabled by default and sends it when a management surface needs paused jobs', async () => {
    await listCronJobsRpc()
    await listCronJobsRpc({ includeDisabled: true })

    expect(rpc.mock.calls[0][1]).toEqual({ action: 'list' })
    expect(rpc.mock.calls[1][1]).toEqual({ action: 'list', include_disabled: true })
  })

  it('omits repeat and continuity so the schedule kind keeps its own defaults', async () => {
    await createCronJobRpc({ name: 'digest', schedule: '0 9 * * *', prompt: 'summarize' })

    expect(sentParams()).toEqual({ action: 'add', name: 'digest', schedule: '0 9 * * *', prompt: 'summarize' })
  })

  it('sends a repeat cap and continuity when the caller set them', async () => {
    await createCronJobRpc({ name: 'digest', schedule: '@daily', prompt: 'go', repeat: 3, continuity: true })

    expect(sentParams()).toMatchObject({ repeat: 3, continuity: true })
  })

  // The handler reads the job id off `name` for remove/pause/resume, not off an
  // `id` key — a helper spelling it `id` gets a silent no-op.
  it('addresses remove/pause/resume by `name`', async () => {
    await updateCronJobStateRpc({ action: 'pause', jobId: 'job-7' })

    expect(rpc).toHaveBeenCalledWith('cron.manage', { action: 'pause', name: 'job-7' })
  })
})
