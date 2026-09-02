/**
 * The ROSTER — every bot this window can reach, from every connection, merged.
 *
 * Pure. The store fetches; this decides what the list IS, including the two
 * things a rename breaks: a handle collision between two connections, and an
 * old handle that must keep resolving for one generation so a mention typed a
 * second ago still lands.
 */

import { botDisplayName, botHandle, groupMemberKey } from '../ids'

import { type BotMeta, decodeBotMeta } from './meta'

/** A profile row, as much of `profiles.list` as the roster needs. */
export interface RosterRowInput {
  name: string
  description?: string
  display_name?: string
  has_avatar?: boolean
  is_default?: boolean
  model?: null | string
  ui_meta?: unknown
  last_session?: null | { id: string; last_active: number; preview: string; root_title?: string; title: string }
  worker_session?: null | { id: string; last_active: number; source: string; title: string }
  /** The registry's answer for this profile, resolved SERVER-SIDE by title.
   *  Absent means the gateway could not look; `null` means it looked and this
   *  bot has no chat yet. Those are different facts and the roster keeps them
   *  apart, because reading a failure as "no chat" is what makes a client mint
   *  a duplicate. */
  canonical_session?: null | { id: string; last_active?: number; preview: string; resolved_id: string }
  preferred_session?: null | {
    id: string
    /** The gateway reports this; ignoring it made a bot whose only activity is
     *  its pinned Bot Chat sort as idle, because `last_session` cannot see a
     *  hidden session. */
    last_active?: number
    preview: string
    resolved_id: string
    root_title: string
  }
}

export interface RosterRow {
  profile: string
  connectionId?: string
  /** Unique within the roster; source-qualified only on a collision. */
  handle: string
  key: string
  name: string
  meta: BotMeta
  hasAvatar: boolean
  isDefault: boolean
  description: string
  model: null | string
  /** ms epoch of the most recent activity of ANY kind, or 0. */
  lastActive: number
  /** This bot's canonical chat, as the registry named it. Used to tell a bot's
   *  forever-chat apart from an ordinary session — they are different modes of
   *  conversation and must not be confused for one another. */
  canonicalId?: string
  preview: string
  /** A `kanban`/`tool` worker is running — the profile is ACTIVE even with no
   *  recent human chat. Reading only `last_session` paints a busy agent idle. */
  working: boolean
  /** Whether this row's `meta` came from a source that actually READ
   *  `ui_meta`, or is merely the empty default.
   *
   *  A source that enumerates NAMES only (`host.agents()` — the Rust roster
   *  reads `GET /api/profiles` and extracts names) yields `meta: {}`, which is
   *  indistinguishable from a bot that genuinely has no record. Writing that
   *  back is a DELETE: `profiles.configure` merges `ui_meta` key-wise, so a
   *  `{chat, v}` write replaces the whole `hermes-bots` value and takes the
   *  bot's title, its `hidden` flag and every room membership with it.
   *  `saveBotMeta` refuses on a row whose meta was never read. */
  metaKnown: boolean
}

/** Strip the agent-to-agent wire prefix from a preview. Deliberately not
 *  localised: it is the literal text the transports send. */
const A2A_RE = /^Message from [^(]*\((@[^)]+)\):\s*/

export const stripA2APrefix = (text: string): string => text.replace(A2A_RE, '')

function rowFrom(input: RosterRowInput, connectionId: string | undefined, metaKnown: boolean): RosterRow {
  const meta = decodeBotMeta(input.ui_meta)
  const preferred = input.preferred_session
  const last = input.last_session
  const worker = input.worker_session

  const canonical = input.canonical_session

  return {
    ...(connectionId ? { connectionId } : {}),
    ...(canonical ? { canonicalId: canonical.id } : {}),
    description: input.description ?? '',
    handle: botHandle(input.name),
    hasAvatar: Boolean(input.has_avatar),
    isDefault: Boolean(input.is_default),
    key: groupMemberKey(input.name, connectionId),
    lastActive: Math.max(preferred?.last_active ?? 0, last?.last_active ?? 0, worker?.last_active ?? 0),
    meta,
    metaKnown,
    model: input.model ?? null,
    name: meta.title || input.display_name || botDisplayName(input.name),
    preview: stripA2APrefix(preferred?.preview ?? last?.preview ?? ''),
    profile: input.name,
    working: Boolean(worker)
  }
}

/**
 * Merge the local roster with every connected machine's.
 *
 * Two agents on two machines can share a name; a bare `@radar` would then be
 * ambiguous, and silently picking one is how a message goes to the wrong
 * machine. So a COLLIDING handle is source-qualified (`@radar-laptop`) and a
 * unique one is left bare — qualifying everything would make the common
 * single-machine case ugly for a problem it does not have.
 */
export function mergeMultiSourceRoster(
  sources: readonly {
    connectionId?: string
    label?: string
    /** True only when this source's rows carry a real `ui_meta`. */
    metaKnown?: boolean
    rows: readonly RosterRowInput[]
  }[]
): RosterRow[] {
  const rows = sources.flatMap(source =>
    source.rows.map(row => rowFrom(row, source.connectionId, source.metaKnown === true))
  )

  const counts = new Map<string, number>()

  for (const row of rows) {
    counts.set(row.handle, (counts.get(row.handle) ?? 0) + 1)
  }

  const labelFor = new Map(sources.filter(s => s.connectionId).map(s => [s.connectionId!, s.label ?? s.connectionId!]))

  return rows.map(row => {
    if ((counts.get(row.handle) ?? 0) < 2 || !row.connectionId) {
      return row
    }

    const suffix = (labelFor.get(row.connectionId) ?? row.connectionId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

    return { ...row, handle: suffix ? `${row.handle}-${suffix}` : row.handle }
  })
}

/**
 * Resolve a mention against the roster, INCLUDING one generation of stale
 * handles.
 *
 * A rename changes the tag; a mention typed against the previous roster paint
 * must still land, or renaming an agent silently breaks the message someone is
 * halfway through writing (desktop's `mention-renamed-bots`).
 */
export function resolveRosterMention(
  tag: string,
  roster: readonly RosterRow[],
  previousHandles: Readonly<Record<string, string>> = {}
): null | RosterRow {
  const needle = tag.toLowerCase().replace(/^@/, '')
  const direct = roster.find(row => row.handle.toLowerCase() === needle)

  if (direct) {
    return direct
  }

  const key = previousHandles[needle]

  return (key ? roster.find(row => row.key === key) : undefined) ?? null
}

/** handle → key, for the NEXT paint's stale-handle map. */
export const handleIndex = (roster: readonly RosterRow[]): Record<string, string> =>
  Object.fromEntries(roster.map(row => [row.handle.toLowerCase(), row.key]))

/** Roster order: working first, then most recently active, then by name. */
export function sortRoster(roster: readonly RosterRow[]): RosterRow[] {
  return [...roster].sort((a, b) => {
    if (a.working !== b.working) {
      return a.working ? -1 : 1
    }

    if (a.lastActive !== b.lastActive) {
      return b.lastActive - a.lastActive
    }

    return a.name.localeCompare(b.name)
  })
}

/** Rows the roster shows: `hidden` is a per-bot opt-out, not a delete. */
export const visibleRoster = (roster: readonly RosterRow[], showHidden: boolean): RosterRow[] =>
  showHidden ? [...roster] : roster.filter(row => row.meta.hidden !== true)
