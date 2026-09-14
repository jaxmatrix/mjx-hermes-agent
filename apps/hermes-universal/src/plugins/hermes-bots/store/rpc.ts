/**
 * Every gateway call Bot Mode makes, typed, in one file.
 *
 * All of them ride `host.request` (or `host.requestProfile` for a member on
 * another machine) — there is NO new backend surface in this feature, and this
 * file is the proof of that claim: if a method is not named here, Bot Mode does
 * not call it.
 *
 * The typed helpers in `lib/gateway-rpc.ts` cover most of these already, but a
 * plugin may not import `@/` (that fence is what keeps the SDK honest), so the
 * shapes are re-declared against the wire. They are checked against the real
 * ones in `rpc.contract.test.ts`.
 */

import { host } from '@hermes/plugin-sdk'

import { BOT_CHAT_TITLE } from '../ids'
import type { BotMeta } from '../model/meta'
import { BOT_META_KEY } from '../model/meta'
import type { RosterRowInput } from '../model/roster'

/** A route to one agent, local or on another connection. */
export interface AgentRoute {
  connectionId?: string
  profile: string
}

const isRemote = (route?: AgentRoute): route is AgentRoute & { connectionId: string } =>
  Boolean(route?.connectionId)

/**
 * ONE dispatch point.
 *
 * A local call goes through `host.request`; a call to an agent on another
 * connection goes through `host.requestProfile`, which MJXHRM-446 routes over
 * that machine's own socket — the window's gateway never switches, which is the
 * whole point of the cross-machine design.
 */
async function call<T>(method: string, params: Record<string, unknown>, route?: AgentRoute): Promise<T> {
  if (isRemote(route)) {
    return host.requestProfile<T>({ connectionId: route.connectionId, profile: route.profile }, method, params)
  }

  return host.request<T>(method, route?.profile ? { ...params, profile: route.profile } : params)
}

// ── profiles ────────────────────────────────────────────────────────────────

export interface ProfilesRoster {
  profiles: RosterRowInput[]
  /** The gateway injects the teammate protocol itself. Absent means it does
   *  not, and the UI says so rather than writing prose into a user's SOUL. */
  bot_mode_protocol?: boolean
}

export const listProfiles = (
  options: { preferredSessionIds?: Record<string, string>; route?: AgentRoute } = {}
): Promise<ProfilesRoster> =>
  call<ProfilesRoster>(
    'profiles.list',
    {
      include_sessions: true,
      ...(options.preferredSessionIds ? { preferred_session_ids: options.preferredSessionIds } : {})
    },
    options.route
  )

export interface ConfigureResult {
  ok?: boolean
  applied?: Record<string, boolean | undefined>
}

/** Write ONE profile's Bot Mode record. `ui_meta` merges key-wise server-side,
 *  so this touches nothing else on the profile. */
export const writeBotMeta = (name: string, meta: BotMeta, route?: AgentRoute): Promise<ConfigureResult> =>
  call<ConfigureResult>('profiles.configure', { name, ui_meta: { [BOT_META_KEY]: meta } }, route)

export const createProfile = (params: {
  clone_from?: string
  description?: string
  model?: string
  name: string
  provider?: string
}): Promise<{ name?: string; ok?: boolean }> => call('profiles.create', { ...params })

export const getAvatar = (name: string, route?: AgentRoute): Promise<{ data?: string; found: boolean; mime?: string }> =>
  call('profiles.get_asset', { asset: 'avatar', name }, route)

export const setAvatar = (name: string, data: string): Promise<{ ok?: boolean; size?: number }> =>
  call('profiles.set_asset', { asset: 'avatar', data, name })

// ── sessions ────────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string
  title: string
  /** Always `''` on the exact-title lookup — the gateway reads a `preview`
   *  column that does not exist, and only `list_sessions_rich` synthesises one.
   *  A row's preview comes from `profiles.list`, never from here. */
  preview?: string
  message_count?: number
  started_at?: number
  /** Only on the exact-title lookup: the live tip a resume should target. */
  resolved_id?: string
}

/**
 * What `session.create` actually answers — THREE ID SPACES, two of them here.
 *
 * `session_id` is the RUNTIME handle: an 8-hex key into the gateway's in-memory
 * `_sessions` map, valid only while this process holds the session.
 * `stored_session_id` is the DURABLE row key, and the only one `session.resume`,
 * `session.set_hidden` or any later client can resolve.
 *
 * Reading the first as if it were the second is what made every bot answer
 * `session not found` forever: a runtime id is never a row id in any database.
 */
export interface CreatedSession {
  session_id?: string
  stored_session_id?: string
}

/**
 * Resolve ONE session by its exact title.
 *
 * O(1) against the core schema's unique title index, and — unlike a windowed
 * listing — unaffected by how busy the profile is, which is what makes
 * adopt-before-mint reliable. Hidden rows DO resolve, because a canonical chat
 * is normally born hidden.
 *
 * The returned title is CHECKED by the caller: an older gateway ignores the
 * param and answers a normal listing, so a one-element result is not a match.
 */
export const findSessionByTitle = (title: string, route?: AgentRoute): Promise<{ sessions?: SessionRow[] }> =>
  call('session.list', { include_hidden: true, title }, route)

/** Mint a session. NOT `startNewSession()` — a Bot Mode session is born hidden,
 *  titled and owned by a named profile. */
export const createSession = (params: { cwd?: string; title: string }, route?: AgentRoute): Promise<CreatedSession> =>
  call('session.create', { cols: 96, hidden: true, title: params.title, ...(params.cwd ? { cwd: params.cwd } : {}) }, route)

/**
 * Write the title, and by doing so MATERIALISE the row.
 *
 * `session.create` deliberately persists nothing — "the row is now created
 * lazily on the first prompt", because every launch and every draft opens a
 * session just to paint a composer. A Bot Mode session has no first prompt to
 * wait for, so without this call it never becomes a row and its stored id
 * addresses nothing.
 *
 * Takes the RUNTIME id: the gateway resolves the live session, then persists
 * it — and applies the `hidden` flag `session.create` was holding, so the chat
 * is born hidden in the same step. Throws 4022 when another writer already
 * holds the title; the caller adopts the winner rather than minting again.
 */
export const setSessionTitle = (runtimeSessionId: string, title: string, route?: AgentRoute): Promise<unknown> =>
  call('session.title', { session_id: runtimeSessionId, title }, route)

export const setSessionHidden = (sessionId: string, hidden: boolean, route?: AgentRoute): Promise<unknown> =>
  call('session.set_hidden', { hidden, session_id: sessionId }, route)

export const submitPrompt = (runtimeSessionId: string, text: string, route?: AgentRoute): Promise<unknown> =>
  call('prompt.submit', { session_id: runtimeSessionId, text }, route)

/** The canonical chat lookup, pre-titled. */
export const findBotChat = (route?: AgentRoute): Promise<{ sessions?: SessionRow[] }> =>
  findSessionByTitle(BOT_CHAT_TITLE, route)

// ── cron (Routines) ─────────────────────────────────────────────────────────

export interface CronRow {
  id: string
  name?: null | string
  prompt?: null | string
  enabled: boolean
  schedule_display?: null | string
  next_run_at?: null | string
  last_run_at?: null | string
  last_error?: null | string
  profile?: null | string
}

export const listRoutines = (route: AgentRoute): Promise<{ jobs?: CronRow[] }> =>
  call('cron.manage', { action: 'list', include_disabled: true }, route)

export const createRoutine = (
  params: { name: string; prompt: string; schedule: string },
  route: AgentRoute
): Promise<unknown> => call('cron.manage', { action: 'create', ...params }, route)

export const setRoutineState = (
  jobId: string,
  action: 'pause' | 'remove' | 'resume',
  route: AgentRoute
): Promise<unknown> => call('cron.manage', { action, job_id: jobId }, route)

// ── a member's transcript ───────────────────────────────────────────────────

/**
 * Read a member session's messages, WITH their timestamps.
 *
 * Rule 18 puts the transcript's authority in the REST read — but a plugin
 * cannot reach `/api/sessions/{id}/messages`: `ctx.rest` is namespaced to the
 * plugin's own backend, and widening it would be a far bigger door than this
 * needs. `session.resume { omit_messages: false }` returns the SAME projection
 * (`_history_to_messages`) that route does, so the authority is unchanged and
 * only the transport differs.
 *
 * `host.bindSession` is what issues it, because a member session wants a live
 * slice anyway and two resumes for one open would be a waste.
 */
export async function readTranscript(storedSessionId: string, route: AgentRoute): Promise<TranscriptMessage[]> {
  const bound = await host.bindSession(storedSessionId, { profile: route.profile, withHistory: true })

  return bound.ok ? (bound.messages ?? []).map(message => ({ ...message, at: (message.timestamp ?? 0) * 1_000 })) : []
}

export interface TranscriptMessage {
  role: string
  text: string
  at?: number
}
