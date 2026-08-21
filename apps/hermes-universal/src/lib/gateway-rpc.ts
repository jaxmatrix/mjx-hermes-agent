/**
 * Typed clients for the gateway RPC methods that arrived with the 2026-08-09
 * backend sync (MJXHRM-230).
 *
 * Written once, here, instead of inside each feature that wants one. The
 * gateway hand-parses `params` — there is no schema on the wire — so a method
 * called with `sessionId` where it wanted `session_id` does not fail loudly,
 * it comes back as a bare `4001 session not found`. Every helper below spells
 * its handler's parameter names exactly and returns that handler's literal
 * result shape, so a caller never has to read the Python to call it.
 *
 * Transport only: no atoms, no UI, no optimistic painting. The feature tickets
 * build the surfaces on top of these.
 */

import { gatewayRpcErrorCode, JSON_RPC_METHOD_NOT_FOUND } from '@/gateway/rpc-error'
import { requestGateway } from '@/store/gateway'
import type { MessageReaction } from '@/types/hermes'

/**
 * True when a JSON-RPC call failed because the backend predates the method.
 *
 * Every method in this file is newer than some gateway a user may still be
 * pointed at, so a caller that degrades gracefully tests the rejection with
 * this rather than reading the message itself.
 *
 * The gateway answers an unimplemented method with the JSON-RPC code -32601
 * (`tui_gateway/server.py handle_request()`), and the transport now keeps that
 * code (gateway/rpc-error.ts). When it is present it is the ANSWER, in both
 * directions: a -32601 whose message we would not have recognised still counts,
 * and a handler that genuinely failed does not stop counting merely because its
 * message quotes a nested -32601 from something it called (an MCP server behind
 * a tool does exactly that) — which used to latch a surface into "this backend
 * is old" permanently.
 *
 * The prose match stays as the fallback for rejections that never came off the
 * wire as a JSON-RPC frame: a locally constructed Error, a rejection re-thrown
 * by a wrapper, a gateway whose error frame carries no `code`, and desktop's
 * copy of this helper, which still only has the message to go on.
 */
export function isMissingRpcMethod(error: unknown): boolean {
  const code = gatewayRpcErrorCode(error)

  if (code !== null) {
    return code === JSON_RPC_METHOD_NOT_FOUND
  }

  const message = error instanceof Error ? error.message : String(error)

  return /method not found|-32601|unknown method|no such method/i.test(message)
}

// --- message.react ---------------------------------------------------------

/** Which persisted row to react to. A message that has round-tripped through a
 *  resume carries the durable `messages.id`; a LIVE one has no row id yet, so
 *  it names the role whose newest row it means — which is the message the user
 *  just reacted to. The backend requires exactly one of the two. */
export type MessageReactTarget = { newest_role: 'assistant' | 'user' } | { row_id: number }

export interface MessageReactResult {
  /** The row the backend resolved — learn it so later toggles address it directly. */
  row_id: number
  reactions: MessageReaction[]
}

/**
 * Set or clear one author's emoji reaction on a persisted message.
 *
 * iOS Tapback semantics, enforced in the DB layer: one reaction per author per
 * message, re-sending the same emoji retracts it, `emoji: null` clears
 * unconditionally. The returned list is authoritative — an optimistic caller
 * should let it win rather than merging.
 */
export function reactToMessage(params: {
  /** Defaults to `'user'`; the agent reacts with `'agent'` through its own tool. */
  author?: MessageReaction['author']
  emoji: null | string
  sessionId: string
  target: MessageReactTarget
}): Promise<MessageReactResult> {
  return requestGateway<MessageReactResult>('message.react', {
    session_id: params.sessionId,
    ...params.target,
    emoji: params.emoji,
    author: params.author ?? 'user'
  })
}

// --- preview.read.respond / window.read.respond ----------------------------

/** `expired` means the tool's bounded wait already timed out — the answer was
 *  accepted and discarded, which is not an error (the gateway passes
 *  `allow_expired=True` precisely so a slow renderer doesn't get a 4009). */
export interface AgentReadRespondResult {
  status: 'expired' | 'ok'
}

/** Answer a `preview.read.request` (the agent's read_preview tool). `text` is a
 *  JSON string of the active preview tab's contents; empty means nothing open. */
export function respondPreviewRead(requestId: string, text: string): Promise<AgentReadRespondResult> {
  return requestGateway<AgentReadRespondResult>('preview.read.respond', { request_id: requestId, text })
}

/** Answer a `window.read.request` (the agent's read_window_below tool). `text`
 *  is a JSON string describing the OS window under the app; empty means
 *  unavailable. See store/agent-read-requests.ts, which owns the frame half. */
export function respondWindowRead(requestId: string, text: string): Promise<AgentReadRespondResult> {
  return requestGateway<AgentReadRespondResult>('window.read.respond', { request_id: requestId, text })
}

// --- session.workspace.move ------------------------------------------------

export interface SessionWorkspaceMoveResult {
  branch?: null | string
  /** The path the backend actually resolved (`~` expanded, absolute). */
  cwd?: string
  git_repo_root?: null | string
}

/**
 * Re-home a STORED session's workspace into another folder — the fix for a chat
 * created in the wrong directory, without recreating it.
 *
 * The git branch/root columns are REPLACED rather than enriched: the point of
 * the move is to change which project claims the session, and a stale
 * `git_repo_root` would keep it grouped under the project it left. A live agent
 * bound to the row follows, so its tools re-anchor immediately — but a session
 * mid-turn refuses with `session busy` rather than yanking the workspace out
 * from under a running tool.
 */
export function moveSessionWorkspace(params: {
  cwd: string
  profile?: null | string
  /** The STORED session key, not a live runtime session id. */
  sessionKey: string
}): Promise<SessionWorkspaceMoveResult> {
  return requestGateway<SessionWorkspaceMoveResult>('session.workspace.move', {
    cwd: params.cwd,
    session_key: params.sessionKey,
    ...(params.profile ? { profile: params.profile } : {})
  })
}

// --- subagent.steer --------------------------------------------------------

/**
 * Why a steer was refused. Present ONLY on `rejected`, and they do not mean the
 * same thing to a user: `not_accepting` is a race they lost by a hair,
 * `unknown_subagent` means the work is already over, `not_owner` /
 * `no_session_authority` mean this window addressed the wrong session and the
 * steer would never work no matter how fast they were.
 *
 * `steer_failed` (the child's own `steer()` refused or raised) and
 * `empty_text`/`no_agent` are backstops the UI folds into the generic refusal.
 * Source: `tools/delegate_tool.py` `steer_subagent_reason` + the
 * `subagent.steer` handler in `tui_gateway/methods_session.py`.
 */
export type SubagentSteerReason =
  | 'empty_text'
  | 'no_agent'
  | 'no_session_authority'
  | 'not_accepting'
  | 'not_owner'
  | 'steer_failed'
  | 'unknown_subagent'
  | (string & {})

export interface SubagentSteerResult {
  /** Set only when `status` is `rejected`. Older gateways omit it entirely, so
   *  a caller must still have a generic refusal message. */
  reason?: SubagentSteerReason
  /** `rejected` = the child could not be resolved, is not ours, or is already
   *  gone. NOT an RPC error — the backend answers 200 either way, so a caller
   *  that only catches rejections silently drops the steer. */
  status: 'queued' | 'rejected'
  subagent_id: string
  text: string
}

/**
 * Queue steering text into a live delegated child without stopping it — the
 * redirection-side mirror of `subagent.interrupt`. The text is appended to the
 * child's last tool result at its next iteration boundary, so the in-flight
 * tool call is never cut.
 *
 * "queued" is not "delivered": a child already past its final tool batch has no
 * boundary left to drain into. That race now rides on the `subagent.complete`
 * event as `missed_steer` (store/subagents.ts folds it onto the row). It used
 * to reach no client at all — the miss was appended to the delegate tool result
 * the parent MODEL reads, while the event carried the pre-note summary.
 */
export function steerSubagent(params: {
  sessionId: string
  subagentId: string
  text: string
}): Promise<SubagentSteerResult> {
  return requestGateway<SubagentSteerResult>('subagent.steer', {
    session_id: params.sessionId,
    subagent_id: params.subagentId,
    text: params.text
  })
}

// --- wake.start / wake.stop / wake.status / wake.pause / wake.resume -------

/**
 * WHERE the microphone lives, as decided by the backend, not by us.
 *
 * `"local"` — the gateway host opened its own PortAudio device and this client
 * does nothing further; detection just arrives as a `wake.detected` event.
 * `"client"` — the host has no usable input (a headless box, a container), so
 * openWakeWord still runs there but the audio has to come from here, one
 * `wake.feed` call at a time. Reading this field is not optional: streaming
 * frames at a `"local"` detector is wasted bandwidth, and NOT streaming at a
 * `"client"` one is a detector that will never fire.
 */
export type WakeCapture = 'client' | 'local'

/** The surface identity we claim; the backend scopes mic ownership by it. */
const WAKE_SURFACE = 'gui'

export interface WakeStartResult {
  started: boolean
  /** `unavailable` | `disabled` | `disabled_for_surface` | `owned`, else absent. */
  reason?: null | string
  hint?: null | string
  phrase?: string
  provider?: string
  owner_surface?: null | string
  enabled_persisted?: boolean
  capture?: WakeCapture
  sample_rate?: number
  /** Detector frame size in samples (1280 = 80 ms at 16 kHz). */
  frame_length?: number
}

export interface WakeStatusResult {
  listening: boolean
  owned_by_caller: boolean
  owner_surface?: null | string
  phrase?: string
  provider?: string
  available: boolean
  hint?: null | string
  enabled: boolean
  audio_silent?: boolean
  capture?: WakeCapture
  local_input_available?: boolean
  sample_rate?: number
  frame_length?: number
}

export interface WakeStopResult {
  stopped: boolean
  reason?: null | string
  disabled_persisted?: boolean
}

export interface WakePauseResult {
  paused: boolean
  reason?: null | string
}

export interface WakeResumeResult {
  resumed: boolean
  reason?: null | string
}

/** First use lazily installs the onnxruntime detection engine, which is a big
 *  download — nowhere near the client's default timeout. */
const WAKE_START_TIMEOUT_MS = 180_000

/**
 * Arm the wake detector for this client.
 *
 * `persist: true` is the deliberate-click path and writes `wake_word.enabled` to
 * the config — upstream's "the toggle IS the config". A passive re-arm (app
 * start, after a voice conversation) must NOT persist, or a mic could become
 * permanently enabled without anyone asking for it.
 */
export function startWakeWord(options: { persist?: boolean } = {}): Promise<WakeStartResult> {
  return requestGateway<WakeStartResult>(
    'wake.start',
    {
      surface: WAKE_SURFACE,
      // We can supply a microphone, so a backend with none should say so rather
      // than refuse; it answers `capture: "client"` and we stream.
      client_capture: true,
      ...(options.persist ? { persist: true } : {})
    },
    WAKE_START_TIMEOUT_MS
  )
}

/** Disarm. `persist: true` (the toggle) also writes `wake_word.enabled: false`. */
export function stopWakeWord(options: { persist?: boolean } = {}): Promise<WakeStopResult> {
  return requestGateway<WakeStopResult>('wake.stop', options.persist ? { persist: true } : {})
}

export function wakeWordStatus(): Promise<WakeStatusResult> {
  return requestGateway<WakeStatusResult>('wake.status', { surface: WAKE_SURFACE, client_capture: true })
}

/** Release the mic for a voice conversation, without touching the config. */
export function pauseWakeWord(): Promise<WakePauseResult> {
  return requestGateway<WakePauseResult>('wake.pause', {})
}

export function resumeWakeWord(): Promise<WakeResumeResult> {
  return requestGateway<WakeResumeResult>('wake.resume', {})
}

// --- wake.feed -------------------------------------------------------------

/** The only rate the detector accepts. `wake.start` echoes it back. */
export const WAKE_FEED_SAMPLE_RATE = 16_000
/** Backend's hard cap on one frame: 2s of 16 kHz int16 mono. */
export const WAKE_FEED_MAX_BYTES = 64_000
// One feed is ~80ms of audio pushed several times a second. The client's
// default 120s timeout would let a stalled socket pile up a minute of frames
// behind a call that is already worthless, so fail these fast instead.
const WAKE_FEED_TIMEOUT_MS = 10_000

export interface WakeFeedResult {
  fed: boolean
  /** `null` when fed; otherwise `'not_owner'` (another transport holds the
   *  armed detector) or `'empty'`. */
  reason: null | string
}

/**
 * Push client-captured PCM into the armed wake detector.
 *
 * Used when `wake.start` answered `capture: "client"` — a headless backend has
 * no microphone, so openWakeWord still runs server-side but the audio comes
 * from here. `pcmBase64` must be base64 of int16 mono LITTLE-ENDIAN samples at
 * 16 kHz, at most WAKE_FEED_MAX_BYTES decoded.
 */
export function feedWakeAudio(pcmBase64: string, sampleRate = WAKE_FEED_SAMPLE_RATE): Promise<WakeFeedResult> {
  return requestGateway<WakeFeedResult>('wake.feed', { pcm: pcmBase64, sample_rate: sampleRate }, WAKE_FEED_TIMEOUT_MS)
}

// ===========================================================================
// The 2026-08-18 / 2026-08-20 backend sync (MJXHRM-444)
// ===========================================================================
//
// Same contract as everything above: one helper per handler, spelling that
// handler's parameter names exactly and returning its literal result shape.
//
// A recurring shape in this wave is the optional `profile`. These handlers all
// scope HERMES_HOME around themselves (`mcp_rpc_helpers.resolve_profile`, or
// server.py's `@_profile_scoped`), so passing a profile reads/writes THAT
// profile's config, plugins, projects.db or cron store rather than the one the
// gateway was launched with. Omitting the key means the launch profile — which
// is what every pre-wave caller effectively asked for, so a helper must OMIT it
// rather than send `null`, keeping old call sites byte-identical on the wire.
// A profile the backend cannot find is `4064 profile '<name>' not found`.

/** Spread into a params object: `{...scoped(profile)}`. */
const scoped = (profile?: null | string): { profile?: string } => {
  const name = (profile ?? '').trim()

  return name ? { profile: name } : {}
}

// --- mcp.catalog / mcp.servers.* -------------------------------------------
//
// The per-profile twins of the `/api/mcp/*` REST routes universal already calls
// through src/hermes.ts. They are NOT duplicates: the REST surface serves the
// gateway's LAUNCH profile only, while these take `profile` and can manage any
// profile's servers from one connection. A surface that edits the profile the
// app is currently operating as can keep using either; one that edits another
// profile's MCP config (a profile editor, Bot Mode) has to use these.

export interface McpCatalogServer {
  /** Already present in this profile's `mcp_servers` config. */
  installed: boolean
  /** Installed AND not disabled. `installed && !enabled` is a switched-off row. */
  enabled: boolean
  name: string
  description: string
  /** Env keys that must hold a value before the entry will work — the "needs
   *  setup" signal a catalog UI shows before an install is worth offering. */
  requires: string[]
  /** Transport KIND (`stdio` / `http`), reduced from the catalog's spec object. */
  transport: string
}

/** The bundled MCP catalog with one profile's install/enable state folded in. */
export function listMcpCatalog(profile?: null | string): Promise<{ servers: McpCatalogServer[] }> {
  return requestGateway<{ servers: McpCatalogServer[] }>('mcp.catalog', scoped(profile))
}

/** One configured server, with every secret reduced to its NAME. `env` is a
 *  list of key names with no values, and a header credential shows only as
 *  `auth: 'header'` — a UI can therefore render this straight out of the RPC. */
export interface McpServerConfig {
  name: string
  /** `'unknown'` is a malformed entry — neither `url` nor `command` is set. */
  transport: 'http' | 'stdio' | 'unknown' | (string & {})
  url?: null | string
  command?: null | string
  args: string[]
  /** Env key NAMES only, sorted. Never values. */
  env: string[]
  /** `'oauth'`, `'header'` (inferred from an Authorization header), or absent. */
  auth?: null | string
  /** `null` for a server that does not use OAuth at all — which is NOT the same
   *  as `false` (an OAuth server still waiting to be authenticated). */
  oauth_tokens_present: boolean | null
  enabled: boolean
  tools?: null | string[]
}

export function listMcpServersForProfile(profile?: null | string): Promise<{ servers: McpServerConfig[] }> {
  return requestGateway<{ servers: McpServerConfig[] }>('mcp.servers.list', scoped(profile))
}

/**
 * The `mcp_servers` entry to save. Either `url` (http) or `command` (stdio) is
 * required unless a `preset` supplies one — `mcp.servers.add` answers 4063
 * when neither resolves.
 */
export interface McpServerConfigInput {
  args?: string[]
  auth?: string
  command?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  tools?: string[]
  url?: string
}

export interface McpServerAddResult {
  ok: boolean
  name: string
  server: McpServerConfig
}

/**
 * Add a server to a profile's config.yaml.
 *
 * `bearerToken` is the safe way to give an http server a static credential: the
 * secret is written to that profile's `.env` and only the `Authorization`
 * header TEMPLATE is persisted in config.yaml, so the config file stays
 * shareable. Putting the token in `config.headers` yourself defeats that.
 *
 * Refuses a name that already exists (`4090`) rather than overwriting — the
 * caller decides between rename and remove-then-add. `4001` is the command
 * safety screen rejecting a suspicious stdio invocation.
 */
export function addMcpServer(params: {
  bearerToken?: string
  config?: McpServerConfigInput
  name: string
  /** A catalog preset id; fills in url/command/args the config omits. */
  preset?: string
  profile?: null | string
}): Promise<McpServerAddResult> {
  return requestGateway<McpServerAddResult>('mcp.servers.add', {
    name: params.name,
    ...scoped(params.profile),
    ...(params.preset ? { preset: params.preset } : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.bearerToken ? { bearer_token: params.bearerToken } : {})
  })
}

export interface McpServerSetApiKeyResult {
  ok: boolean
  name: string
  /** The env key the secret actually landed under — the backend picks the
   *  canonical `MCP_<NAME>_API_KEY` when the caller did not name one, so a UI
   *  that wants to show "stored as X" must read this rather than assume. */
  env_var: string
  server: McpServerConfig
}

/** Store a credential for a server: written to the profile's `.env`, with the
 *  config.yaml entry rewritten to reference it (header template for http, an
 *  `env:` reference for stdio). */
export function setMcpServerApiKey(params: {
  envVar?: string
  name: string
  profile?: null | string
  value: string
}): Promise<McpServerSetApiKeyResult> {
  return requestGateway<McpServerSetApiKeyResult>('mcp.servers.set_api_key', {
    name: params.name,
    value: params.value,
    ...scoped(params.profile),
    ...(params.envVar ? { env_var: params.envVar } : {})
  })
}

export interface McpServerTestResult {
  /** A FAILED probe is `{ok: false}` on a SUCCESSFUL RPC, not a rejection — a
   *  caller that only catches errors reports every broken server as working. */
  ok: boolean
  tools: { name: string; description: string }[]
  /** Present on `ok: false`. */
  error?: string
  prompts?: number
  resources?: number
  /** This server authenticates by OAuth, so a green probe is only meaningful
   *  alongside `oauth_tokens_present`. */
  oauth_needed?: boolean
  /** `null` when the server does not use OAuth. `false` with `ok: false` is the
   *  "connected fine but has no token" case the backend fails deliberately: a
   *  server that serves tools/list anonymously would otherwise probe green. */
  oauth_tokens_present?: boolean | null
}

/** Probe a server: connect, list tools, disconnect. A cold stdio `npx` spawn
 *  can take many seconds — the backend runs this off the RPC thread. */
export function testMcpServerForProfile(name: string, profile?: null | string): Promise<McpServerTestResult> {
  return requestGateway<McpServerTestResult>('mcp.servers.test', { name, ...scoped(profile) })
}

/** Remove a server from a profile's config.yaml. `4064` when it was not there. */
export function removeMcpServer(name: string, profile?: null | string): Promise<{ ok: boolean; removed: boolean }> {
  return requestGateway<{ ok: boolean; removed: boolean }>('mcp.servers.remove', { name, ...scoped(profile) })
}

export interface McpOAuthStartResult {
  ok: boolean
  /** Poll with THIS, not with the server name. */
  session_id: string
  /** Open in the system browser; the backend holds a loopback listener for the
   *  redirect, so nothing has to be handled in-app. */
  auth_url: string
  flow: string
}

/**
 * Begin an OAuth flow for an http MCP server in a profile.
 *
 * Refuses (`4001`) for a stdio server — those authenticate by env key, use
 * `setMcpServerApiKey` — and for a server already using header auth.
 */
export function startMcpServerOAuth(name: string, profile?: null | string): Promise<McpOAuthStartResult> {
  return requestGateway<McpOAuthStartResult>('mcp.servers.oauth.start', { name, ...scoped(profile) })
}

export interface McpOAuthPollResult {
  ok: boolean
  /** `approved` means the tokens are on disk for that server in that profile. */
  status: 'approved' | 'error' | 'pending' | (string & {})
  error_message?: string
  auth_url?: string
  tools?: string[]
}

/** Poll a flow started by `startMcpServerOAuth`. Both `name` and `session_id`
 *  are required — the session id alone does not carry the profile scope the
 *  token write needs. */
export function pollMcpServerOAuth(params: {
  name: string
  profile?: null | string
  sessionId: string
}): Promise<McpOAuthPollResult> {
  return requestGateway<McpOAuthPollResult>('mcp.servers.oauth.poll', {
    name: params.name,
    session_id: params.sessionId,
    ...scoped(params.profile)
  })
}

// --- mcp.setup.respond -----------------------------------------------------

/** The outcome of an MCP setup card, as the `setup_mcp` tool wants to read it. */
export interface McpSetupOutcome {
  detail?: string
  server?: string
  status: string
  tools?: string[]
}

/**
 * Answer an MCP setup consent card.
 *
 * Note the payload key is `result`, not the `text` its sibling responders use
 * (`methods_prompt.py` `_respond(rid, params, "result", …)`) — sending `text`
 * here is a silent no-answer. Like the other responders it is `allow_expired`,
 * so a late answer resolves as `expired` rather than raising: the setup tool
 * waits ten minutes and an OAuth round-trip can outlive that.
 */
export function respondMcpSetup(requestId: string, outcome: McpSetupOutcome): Promise<AgentReadRespondResult> {
  return requestGateway<AgentReadRespondResult>('mcp.setup.respond', {
    request_id: requestId,
    result: JSON.stringify(outcome)
  })
}

// --- preview.act.respond / tour.respond ------------------------------------

/**
 * Answer a `preview.act.request` (the agent's drive_preview tool). `text` is a
 * JSON string of the interaction's outcome — what it acted on, the live
 * url/title, and a refreshed element inventory.
 *
 * `allow_expired`, like every responder in this family: a settle-and-rescan
 * routinely loses the race with the tool's bounded wait, and that answers
 * `expired`, which is not an error.
 */
export function respondPreviewAct(requestId: string, text: string): Promise<AgentReadRespondResult> {
  return requestGateway<AgentReadRespondResult>('preview.act.respond', { request_id: requestId, text })
}

/** Answer a `tour.request` (the agent's tour tool). `text` is a JSON string:
 *  matched targets, the active step, or an error naming the bad selector.
 *  `allow_expired` — driver.js injection into a slow page can outlive the wait. */
export function respondTour(requestId: string, text: string): Promise<AgentReadRespondResult> {
  return requestGateway<AgentReadRespondResult>('tour.respond', { request_id: requestId, text })
}

// --- profiles.* ------------------------------------------------------------
//
// The ws twins of the `/api/profiles` REST routes in src/hermes.ts, plus three
// things REST has no equivalent for: `describe` (the whole editable config in
// one read), `configure` (the editor's Save), and the asset pair (avatars,
// stored server-side so every machine on this gateway paints the same roster).

/** One profile's newest human conversation. Deliberately NOT the first-message
 *  preview the session lists use — a roster wants "where the conversation IS". */
export interface ProfileSessionSummary {
  id: string
  title: string
  preview: string
  started_at: number
  last_active: number
  message_count: number
}

/** A caller-pinned session, resolved. `id` stays the durable pin the caller
 *  asked about; `resolved_id` is the live tip a resume would land on after
 *  context compression, and `root_title` the title the ROOT row carries (the
 *  tip's own title drifts as the conversation is retitled). */
export interface ProfilePreferredSession extends ProfileSessionSummary {
  resolved_id: string
  root_title: string
}

export interface ProfileRosterRow {
  name: string
  path: string
  is_default: boolean
  model: null | string
  provider: null | string
  description: string
  display_name: string
  skill_count: number
  /** Only with `includeSessions`. `null` = no human conversation yet. */
  last_session?: null | ProfileSessionSummary
  /** Freshest `kanban`/`tool` worker row, or `null`. A profile whose worker is
   *  running counts as ACTIVE even with no recent human chat — reading only
   *  `last_session` paints a busy agent as idle. */
  worker_session?: null | { id: string; source: string; title: string; last_active: number }
  /** Only for names passed in `preferredSessionIds`; `null` when the id is gone. */
  preferred_session?: null | ProfilePreferredSession
  /** Client-agnostic UI metadata from profile.yaml (avatar hints, colors, …),
   *  written back through `configureProfile({uiMeta})`. */
  ui_meta?: Record<string, unknown>
  /** Cheap flag so a roster knows whether `getProfileAsset` is worth calling. */
  has_avatar: boolean
}

export interface ProfilesRosterResult {
  profiles: ProfileRosterRow[]
  /** This backend injects the Bot Mode teammate protocol into every session
   *  itself. A client that would otherwise append that protocol to SOUL.md must
   *  skip its write when this is present, or the protocol lands twice. */
  bot_mode_protocol?: boolean
}

/**
 * Roster of profiles with per-profile session previews.
 *
 * The RPC twin of REST `/api/profiles` (`getProfiles`), and richer: REST gives
 * the profile rows alone, this folds in each profile's latest conversation,
 * its running worker and its avatar flag, so a roster paints in ONE call
 * instead of N follow-ups. Pass `includeSessions: false` for the cheap form —
 * the session half opens each profile's state.db.
 */
export function listProfilesRich(
  options: {
    includeSessions?: boolean
    /** `{profileName: sessionId}` — rows whose click target is a pinned chat,
     *  so the preview and the click target describe the same session. */
    preferredSessionIds?: Record<string, string>
  } = {}
): Promise<ProfilesRosterResult> {
  return requestGateway<ProfilesRosterResult>('profiles.list', {
    ...(options.includeSessions === undefined ? {} : { include_sessions: options.includeSessions }),
    ...(options.preferredSessionIds ? { preferred_session_ids: options.preferredSessionIds } : {})
  })
}

export interface ProfileCreateResult {
  ok: boolean
  name: string
  path: string
  soul_written: boolean
  model_set: boolean
  /** The launch profile's `.env` + `auth.json` were copied in. When this is
   *  false and no model was pinned, the new profile has NO inference provider
   *  and its first message will fail — surface it rather than assume success. */
  mirrored: boolean
}

/**
 * Create a profile — the ws twin of `POST /api/profiles` (`createProfile`).
 *
 * `mirrorCredentials` defaults to TRUE on the backend and is the difference
 * between a usable profile and a dead one: `create_profile()` seeds a
 * comment-only `.env` and never copies `auth.json`, so a profile created
 * headlessly is born with no provider and there is no interactive `hermes
 * setup` in this flow to recover it. Pass `false` only for a deliberately
 * isolated profile.
 *
 * `shareAuth` (MJXHRM-450, fixing forward on MJXHRM-444, which typed the rest
 * of this method) SKIPS the `auth.json` COPY so the new profile reads OAuth
 * state through the global-root fallback instead. Copying FORKS token state:
 * with single-use refresh tokens the first refresh on either side invalidates
 * the other, which is how a freshly cloned agent signs its parent out. Static
 * `.env` keys still copy either way — they have no refresh semantics.
 */
export function createProfileRpc(params: {
  cloneAll?: boolean
  cloneFrom?: string
  description?: string
  mirrorCredentials?: boolean
  model?: string
  name: string
  noSkills?: boolean
  provider?: string
  shareAuth?: boolean
  soul?: string
}): Promise<ProfileCreateResult> {
  return requestGateway<ProfileCreateResult>('profiles.create', {
    name: params.name,
    ...(params.description ? { description: params.description } : {}),
    ...(params.cloneFrom ? { clone_from: params.cloneFrom } : {}),
    ...(params.cloneAll === undefined ? {} : { clone_all: params.cloneAll }),
    ...(params.noSkills === undefined ? {} : { no_skills: params.noSkills }),
    ...(params.soul ? { soul: params.soul } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.mirrorCredentials === undefined ? {} : { mirror_credentials: params.mirrorCredentials }),
    ...(params.shareAuth === undefined ? {} : { share_auth: params.shareAuth })
  })
}

export interface ProfileDescription {
  name: string
  description: string
  soul: string
  model: { provider: string; default: string }
  /** Installed skills; `enabled` is the disabled-list model resolved for you. */
  skills: { name: string; enabled: boolean }[]
  toolsets: { name: string; description: string; tool_count: number; enabled: boolean }[]
  /** False = the profile pins no toolset list, so every toolset is enabled.
   *  Saving `enabledToolsets: []` is what clears the pin back to this state —
   *  it does NOT mean "disable everything". */
  toolsets_pinned: boolean
  mcp_servers: { name: string; enabled: boolean; transport: string }[]
}

/** Everything a profile editor needs to render, in one read. `4064` unknown. */
export function describeProfile(name: string): Promise<ProfileDescription> {
  return requestGateway<ProfileDescription>('profiles.describe', { name })
}

/** Which sections `profiles.configure` actually wrote. Every section is applied
 *  independently and best-effort, so a partial failure comes back as `ok:false`
 *  with the guilty key false here — a caller that only reads `ok` cannot tell
 *  the user WHICH half of their Save was lost. */
export interface ProfileConfigureResult {
  ok: boolean
  applied: Partial<Record<'description' | 'mcp_servers' | 'model' | 'skills' | 'toolsets' | 'ui_meta', boolean>>
}

/**
 * Apply an editor Save to a profile.
 *
 * Every list field is REPLACE, not merge: `disabledSkills` and
 * `enabledToolsets` overwrite the stored list wholesale, so a caller must send
 * the complete intended set, never a delta. `uiMeta` is the exception — it
 * merges key-wise, and a key set to `null` deletes it. `uiMeta` also rides
 * `profiles.list` on every roster paint, so the backend caps it at 64 KB and
 * answers `applied.ui_meta: false` past that; store images through
 * `setProfileAsset` and keep a reference here.
 *
 * `model` and `provider` are required together — sending one alone writes
 * nothing.
 */
export function configureProfile(params: {
  description?: string
  disabledSkills?: string[]
  enabledMcpServers?: string[]
  enabledToolsets?: string[]
  model?: string
  name: string
  provider?: string
  soul?: string
  uiMeta?: Record<string, unknown>
}): Promise<ProfileConfigureResult> {
  return requestGateway<ProfileConfigureResult>('profiles.configure', {
    name: params.name,
    ...(params.description === undefined ? {} : { description: params.description }),
    ...(params.soul === undefined ? {} : { soul: params.soul }),
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.provider === undefined ? {} : { provider: params.provider }),
    ...(params.disabledSkills === undefined ? {} : { disabled_skills: params.disabledSkills }),
    ...(params.enabledToolsets === undefined ? {} : { enabled_toolsets: params.enabledToolsets }),
    ...(params.enabledMcpServers === undefined ? {} : { enabled_mcp_servers: params.enabledMcpServers }),
    ...(params.uiMeta === undefined ? {} : { ui_meta: params.uiMeta })
  })
}

/** The only asset kind the backend accepts today (`4066` for anything else). */
export type ProfileAssetKind = 'avatar'

export interface ProfileSetAssetResult {
  ok: boolean
  asset: string
  /** Bytes written; `0` on a clear. */
  size: number
  /** Only on a clear: how many files were actually deleted. */
  removed?: number
}

/**
 * Store a profile's avatar SERVER-side, so every machine on this gateway paints
 * the same image (a locally-cached avatar is per-install by definition).
 *
 * `data` is a `data:image/png;base64,…` URL or bare base64; PNG/JPEG/WebP only,
 * 2 MB decoded. Written atomically, and a format change removes the stale
 * sibling extension rather than leaving two files to race.
 */
export function setProfileAsset(params: {
  asset?: ProfileAssetKind
  data: string
  name: string
}): Promise<ProfileSetAssetResult> {
  return requestGateway<ProfileSetAssetResult>('profiles.set_asset', {
    name: params.name,
    asset: params.asset ?? 'avatar',
    data: params.data
  })
}

/** Delete a profile's asset. Separate from `setProfileAsset` because the
 *  backend keys on a `clear` flag and ignores `data` entirely when it is set —
 *  one function taking `data: string | null` would silently no-op on null. */
export function clearProfileAsset(name: string, asset: ProfileAssetKind = 'avatar'): Promise<ProfileSetAssetResult> {
  return requestGateway<ProfileSetAssetResult>('profiles.set_asset', { name, asset, clear: true })
}

export interface ProfileAssetResult {
  /** `false` is the NORMAL answer for a profile with no avatar — not an error,
   *  so a roster can probe cheaply without a try/catch per row. */
  found: boolean
  data?: string
  mime?: string
  size?: number
}

/** Read a profile asset back as a data URL. */
export function getProfileAsset(name: string, asset: ProfileAssetKind = 'avatar'): Promise<ProfileAssetResult> {
  return requestGateway<ProfileAssetResult>('profiles.get_asset', { name, asset })
}

// --- session.set_hidden ----------------------------------------------------

/**
 * Set or clear a session's `hidden` flag — and its whole compression lineage.
 *
 * `hidden` is the third durable session flag beside `pinned`/`archived`, and it
 * means something none of the others do: the session stays fully resumable by
 * the surface that owns it but is dropped from the shared recents list. It is
 * for sessions a plugin or a background surface manages and does not want in
 * the user's global list — not a soft delete (that is `archived`).
 *
 * Resolution is two-tier and this matters to the caller: a LIVE runtime id
 * resolves first (including a not-yet-persisted draft, deferred to its first
 * prompt), then a STORED id/key in the profile's state.db. So a stored id for a
 * chat that is not live right now works — pass `profile` when that chat belongs
 * to a profile other than the launch one.
 */
export function setSessionHidden(params: {
  hidden: boolean
  profile?: null | string
  sessionId: string
}): Promise<{ hidden: boolean; session_key: string }> {
  return requestGateway<{ hidden: boolean; session_key: string }>('session.set_hidden', {
    session_id: params.sessionId,
    hidden: params.hidden,
    ...scoped(params.profile)
  })
}

// --- session.list ----------------------------------------------------------

export interface SessionListRow {
  id: string
  title: string
  preview: string
  started_at: number
  message_count: number
  source: string
  /** Only on the exact-title lookup. */
  resolved_id?: string
}

/**
 * Resolve ONE session by its exact title.
 *
 * Not a search and not a listing: the core schema has a UNIQUE title index, so
 * at most one row per db carries a given title and this is an O(1) registry
 * lookup for callers that treat a title as an identity key (a canonical
 * per-profile chat). The windowed listing cannot substitute — on a busy profile
 * the row falls out of the recency window and the caller creates a duplicate.
 *
 * Returns a single-element array, or an EMPTY one for no match / an archived
 * row / an internal `tool`/`kanban` source. Hidden rows DO resolve, because a
 * canonical chat is normally born hidden. `resolved_id` is the live tip a
 * resume should target; `id` is the durable root.
 *
 * An older gateway ignores the param and answers a normal listing, so a caller
 * must check the returned title rather than trust a one-element result.
 */
export function findSessionByTitle(params: {
  profile?: null | string
  title: string
}): Promise<{ sessions: SessionListRow[] }> {
  return requestGateway<{ sessions: SessionListRow[] }>('session.list', {
    title: params.title,
    ...scoped(params.profile)
  })
}

// --- projects.discover_repos -----------------------------------------------

/** One row of `projects.discover_repos` — the gateway's `_discover_repos_payload`
 *  shape (tui_gateway/server.py), NOT the `{path, name, branch}` guess this
 *  interface shipped with in MJXHRM-444: nothing consumed it, so the mismatch
 *  typechecked. `sessions`/`last_active` are 0 for a repo the disk scan found
 *  that has never hosted a Hermes session — the whole point of the scan. */
export interface DiscoveredRepo {
  root: string
  label: string
  sessions: number
  last_active: number
  [key: string]: unknown
}

export interface DiscoverReposResult {
  repos: DiscoveredRepo[]
  discovery_policy: { enabled: boolean; [key: string]: unknown }
}

/**
 * Repos for the projects overview: session-derived, plus the disk-scan cache.
 *
 * `scan: true` makes the BACKEND walk its own discovery roots, so repos with
 * zero Hermes sessions surface. That is only correct against a REMOTE gateway:
 * a client scanning its own filesystem is looking at the wrong machine. It is
 * also ignored when the profile's discovery policy is disabled, so a caller
 * cannot force a scan the user turned off.
 *
 * All `projects.*` handlers are now profile-scoped server-side; omitting
 * `profile` reads the LAUNCH profile's projects.db, which is not necessarily
 * the profile the app is operating as.
 */
export function discoverRepos(options: { profile?: null | string; scan?: boolean } = {}): Promise<DiscoverReposResult> {
  return requestGateway<DiscoverReposResult>('projects.discover_repos', {
    ...scoped(options.profile),
    ...(options.scan ? { scan: true } : {})
  })
}

// --- plugins.manage --------------------------------------------------------

export interface AgentPluginRow {
  name: string
  /** The CANONICAL id (`image_gen/fal`). Toggle by this, never by `name`:
   *  names collide across category dirs (two different plugins are "fal"). */
  key: string
  version: string
  description: string
  source: string
  status: string
  /** An Agent Plugins v1 package (plugin.json) rather than a native plugin. */
  portable: boolean
}

export interface PluginInstallResult {
  ok: boolean
  name?: string
  key?: string
  path?: string
  enabled?: boolean
  [key: string]: unknown
}

/**
 * Install a plugin by git identifier or repo URL — a non-interactive clone into
 * `~/.hermes/plugins/` (of the named profile's home, when scoped).
 *
 * `force` re-clones over an existing directory; `enable` defaults to TRUE on
 * the backend, so an install is live immediately unless the caller says
 * otherwise. Failure is an RPC ERROR, not `{ok: false}`: `4019` for a missing
 * identifier, `5026` for a clone/enable that failed — the message is the
 * backend's own and is the thing worth showing.
 */
export function installAgentPlugin(params: {
  enable?: boolean
  force?: boolean
  /** A git identifier (`owner/repo`) or a full repo URL. */
  identifier: string
  profile?: null | string
}): Promise<PluginInstallResult> {
  return requestGateway<PluginInstallResult>('plugins.manage', {
    action: 'install',
    identifier: params.identifier,
    ...scoped(params.profile),
    ...(params.force ? { force: true } : {}),
    ...(params.enable === undefined ? {} : { enable: params.enable })
  })
}

// --- cron.manage -----------------------------------------------------------
//
// The RPC twin of the `/api/cron/*` REST routes in src/hermes.ts. REST is the
// richer surface for the launch profile's jobs; this one exists for the two
// things REST cannot express — a per-profile cron store on a gateway that is
// not running as that profile, and `include_disabled`.

export interface CronManageListResult {
  jobs?: unknown[]
  /** Echoed back ONLY when the gateway honored a `profile` scope. Its presence
   *  is the proof — a caller may then treat every returned job as owned by that
   *  profile; an older gateway omits it and the caller must keep whatever
   *  name-prefix filter it used before. */
  scoped?: string
  [key: string]: unknown
}

/**
 * List a profile's cron jobs.
 *
 * `includeDisabled` defaults to FALSE on the backend, which drops paused jobs
 * entirely — in any UI with an enable/disable toggle that reads as deletion, so
 * a management surface wants it true and a "what runs next" surface does not.
 */
export function listCronJobsRpc(
  options: { includeDisabled?: boolean; profile?: null | string } = {}
): Promise<CronManageListResult> {
  return requestGateway<CronManageListResult>('cron.manage', {
    action: 'list',
    ...scoped(options.profile),
    ...(options.includeDisabled ? { include_disabled: true } : {})
  })
}

/**
 * Create a cron job.
 *
 * `repeat` is a run-count cap; omitting it keeps the schedule kind's own
 * default (once for a one-shot, forever for a recurring one), so `undefined`
 * and any explicit number mean genuinely different things. The backend only
 * accepts a DIGIT string here — it silently drops a negative or non-numeric
 * value back to the default, so validate before calling if the user typed it.
 *
 * `continuity` injects the job's own previous output into each run (stored as
 * the reserved `self` entry in `context_from`) — that is how a recurring job
 * builds on itself instead of starting cold every time.
 */
export function createCronJobRpc(params: {
  continuity?: boolean
  name: string
  profile?: null | string
  prompt: string
  repeat?: number
  schedule: string
}): Promise<Record<string, unknown>> {
  return requestGateway<Record<string, unknown>>('cron.manage', {
    action: 'add',
    name: params.name,
    schedule: params.schedule,
    prompt: params.prompt,
    ...scoped(params.profile),
    ...(params.repeat === undefined ? {} : { repeat: params.repeat }),
    ...(params.continuity === undefined ? {} : { continuity: params.continuity })
  })
}

/** Remove / pause / resume a cron job by id. */
export function updateCronJobStateRpc(params: {
  action: 'pause' | 'remove' | 'resume'
  jobId: string
  profile?: null | string
}): Promise<Record<string, unknown>> {
  return requestGateway<Record<string, unknown>>('cron.manage', {
    action: params.action,
    name: params.jobId,
    ...scoped(params.profile)
  })
}
