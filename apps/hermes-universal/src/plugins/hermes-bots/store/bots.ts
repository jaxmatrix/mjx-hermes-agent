/**
 * The roster, the canonical Bot Chat, and the hidden-session sweep — the
 * EFFECTS half. Every decision they execute is a pure function in `model/`.
 */

import { host, livePollIntervalMs } from '@hermes/plugin-sdk'

import { BOT_CHAT_TITLE, botHandle, groupSessionTitle, isOwnedSessionTitle } from '../ids'
import { type CanonicalAction, maySweep, resolveCanonicalChat } from '../model/canonical'
import { type BotMeta, type BotMetaWriteOutcome, classifyWrite } from '../model/meta'
import { liveRooms, roomsFromRoster, rosterMetaSource } from '../model/rooms'
import { handleIndex, mergeMultiSourceRoster, type RosterRow, type RosterRowInput, sortRoster } from '../model/roster'

import { $botProtocolSupported, $rooms, $roster, $rosterError, $rosterLoading } from './atoms'
import { type AgentRoute, createSession, findBotChat, listProfiles, setSessionHidden, writeBotMeta } from './rpc'

/** Roster refresh cadence.
 *
 *  There is NO `profiles.changed` event — the gateway has no profile-change
 *  broadcast at all — so a roster refresh cannot be fully event-driven. What IS
 *  event-driven: an immediate refresh on `sessions.changed` and on the gateway
 *  opening. This is the backstop underneath both, and it is the ONE poll Bot
 *  Mode keeps (desktop had six). */
export const rosterIntervalMs = (): number => livePollIntervalMs(15_000, 90_000)

let inFlight: null | Promise<RosterRow[]> = null
let previousHandles: Record<string, string> = {}

export const staleHandles = (): Record<string, string> => previousHandles

/**
 * Refresh the roster and rebuild every room from it.
 *
 * SINGLE-FLIGHT: a `sessions.changed` storm, a pane reveal and the backstop can
 * all land in the same tick, and three concurrent `profiles.list` calls against
 * a busy gateway is the kind of self-inflicted load that looks like a backend
 * problem.
 */
export async function refreshRoster(): Promise<RosterRow[]> {
  if (inFlight) {
    return inFlight
  }

  const run = (async () => {
    $rosterLoading.set(true)

    try {
      const local = await listProfiles({ preferredSessionIds: pinnedChats() })

      // Agents on other machines, when MJXHRM-446 has any registered. A remote
      // roster that refuses is NOT fatal: the local half still paints, and the
      // member card is what says a machine is unreachable.
      const remotes = await remoteRosters()

      const roster = sortRoster(
        mergeMultiSourceRoster([{ metaKnown: true, rows: local.profiles ?? [] }, ...remotes])
      )

      $botProtocolSupported.set(local.bot_mode_protocol === true)
      $roster.set(roster)
      $rosterError.set(null)

      const fetchedAt = Date.now()

      $rooms.set(
        liveRooms(
          roomsFromRoster(
            roster.map(row => rosterMetaSource({ name: row.profile, ui_meta: { 'hermes-bots': row.meta } }, row.connectionId)),
            fetchedAt
          )
        )
      )

      previousHandles = { ...previousHandles, ...handleIndex(roster) }

      return roster
    } catch (error) {
      $rosterError.set(error instanceof Error ? error.message : String(error))

      return $roster.get() as RosterRow[]
    } finally {
      $rosterLoading.set(false)
      inFlight = null
    }
  })()

  inFlight = run

  return run
}

/** `{profile: pinned chat id}` — so each row's preview describes the session
 *  its click actually opens, rather than whatever chat was most recent. */
function pinnedChats(): Record<string, string> {
  const out: Record<string, string> = {}

  for (const row of $roster.get()) {
    if (!row.connectionId && row.meta.chat) {
      out[row.profile] = row.meta.chat
    }
  }

  return out
}

/**
 * The agents reachable on OTHER connections.
 *
 * `host.agents()` is the cheap enumeration — one call for the whole registry,
 * with a per-connection outcome, so a machine that is down carries its error
 * rather than vanishing. That distinction is the point: a missing row and a
 * broken row are different facts, and only one of them means "this agent does
 * not exist".
 *
 * Each remote agent's own `ui_meta` is NOT fetched here. Reading it would be one
 * `profiles.list` per connection on every roster refresh — a room's record is
 * already replicated onto the LOCAL members, so the rooms rebuild without it,
 * and a remote agent's look is a cosmetic the local blobatar covers.
 */
async function remoteRosters(): Promise<
  { connectionId: string; label: string; metaKnown: false; rows: RosterRowInput[] }[]
> {
  try {
    const [roster, connections] = await Promise.all([host.agents(), host.connections()])
    const labelOf = new Map(connections.map(connection => [connection.id, connection.label]))
    const failed = new Set(roster.sources.filter(source => !source.ok).map(source => source.connectionId))

    // THE ACTIVE CONNECTION IS ALREADY IN THE ROSTER — `host.agents()` enumerates
    // EVERY registered connection including the one this window is routed to, and
    // `listProfiles()` above has already read that same source, richly. Merging
    // both lists renders every local profile twice: once bare, once
    // source-qualified, because `groupMemberKey` keys them differently and
    // `mergeMultiSourceRoster` collapses handles, not identities.
    //
    // The thin duplicate is worse than cosmetic. It carries no `ui_meta`, so
    // clicking it writes an empty record back over the bot's title, `hidden`
    // flag and rooms.
    //
    // Same rule, same reason as `store/session-sources.ts`'s `excludeConnectionId`.
    // `primary` is the routed connection (not the registry's launch default);
    // `host.activeConnectionId()` is the pre-registry fallback for a window with
    // no row flagged.
    const primaryId = connections.find(connection => connection.primary)?.id ?? host.activeConnectionId()

    const byConnection = new Map<string, RosterRowInput[]>()

    for (const agent of roster.agents) {
      if (failed.has(agent.connectionId) || agent.connectionId === primaryId) {
        continue
      }

      const rows = byConnection.get(agent.connectionId) ?? []

      rows.push({ display_name: agent.label, is_default: agent.isDefault, name: agent.profile })
      byConnection.set(agent.connectionId, rows)
    }

    return [...byConnection.entries()].map(([connectionId, rows]) => ({
      connectionId,
      label: labelOf.get(connectionId) ?? connectionId,
      // NAMES only — the Rust enumerator reads `GET /api/profiles` and never
      // `ui_meta`, so these rows must never be a write source.
      metaKnown: false as const,
      rows
    }))
  } catch {
    // A registry that will not answer is not a roster failure — the local half
    // is still the roster, and a room with only local members still works.
    return []
  }
}

const routeFor = (row: Pick<RosterRow, 'connectionId' | 'profile'>): AgentRoute => ({
  ...(row.connectionId ? { connectionId: row.connectionId } : {}),
  profile: row.profile
})

// ── the canonical Bot Chat ──────────────────────────────────────────────────

export interface OpenChatResult {
  /** `remote` is not a rung of the ladder — the ladder is never reached. */
  action: CanonicalAction['kind'] | 'remote'
  storedId?: string
  error?: string
}

/**
 * Open a bot's private chat, following the six-rung ladder.
 *
 * The LOOKUP is the improvement over desktop: an exact-title `session.list` is
 * O(1) against the unique title index and unaffected by how busy the profile
 * is, where desktop scanned a recency window and minted a duplicate whenever
 * the Bot Chat had fallen out of it.
 */
export async function openBotChat(row: RosterRow): Promise<OpenChatResult> {
  const result = await resolveBotChat(row)

  // Reported HERE because all three call sites — the row tap, the kebab verb
  // and the `hermes://bot/…` deep link — used to drop this on the floor, and a
  // failure the user cannot see is one they retry by clicking again forever.
  if (result.error && result.error !== 'superseded') {
    host.notifyError(
      new Error(result.error),
      result.action === 'retry'
        ? `Could not reach ${row.name}'s chat — try again`
        : `Could not open ${row.name}'s chat`
    )
  }

  return result
}

async function resolveBotChat(row: RosterRow): Promise<OpenChatResult> {
  // A bot on ANOTHER machine cannot have its chat opened here, and pretending
  // otherwise is the whole of the "session not found" the user sees.
  //
  // Every session door the SDK has — `host.openSession`, `host.bindSession` —
  // takes a PROFILE and no connection. So a remote bot's stored id is resumed
  // against THIS gateway, which does not have that session: 4007, on every
  // click, forever, because the pin is not at fault and is never cleared.
  // Worse, `openSession` first switches the ACTIVE profile to the foreign
  // name, which repoints every profile-scoped call in the app at a profile
  // this backend does not have.
  //
  // Desktop refuses the same act for the same reason and says the same thing:
  // reach a bot on another machine by @mentioning it, and the window's gateway
  // stays where it is. `store/remote.ts` is that path.
  //
  // English here, like every other notification raised from this store: `t` is
  // a React hook and a store has no component to hang it on.
  if (row.connectionId) {
    host.notify({
      kind: 'info',
      message: `Stay in this chat and @${handleOf(row)} to message them — this window's gateway stays on this device.`,
      title: `${row.name} lives on another machine`
    })

    return { action: 'remote' }
  }

  const route = routeFor(row)

  let lookup: Awaited<ReturnType<typeof findBotChat>> | null = null
  let lookupFailed = false

  try {
    lookup = await findBotChat(route)
  } catch {
    lookupFailed = true
  }

  const found = lookup?.sessions?.[0]

  const ladder = {
    lookupFailed,
    // `null` (looked, nothing there) and `undefined` (did not look) lead to
    // different rungs, so the failure case must not collapse into a miss.
    ...(lookupFailed ? {} : { lookup: found ? { id: found.id, resolvedId: found.resolved_id, title: found.title } : null }),
    pin: row.meta.chat ?? null
  }

  const action = resolveCanonicalChat(ladder)

  if (action.kind === 'create') {
    const created = await createSession({ title: BOT_CHAT_TITLE }, route)

    if (!created.session_id) {
      return { action: 'create', error: 'session.create returned no id' }
    }

    await pinChat(row, created.session_id)
    await host.openSession(created.session_id, { profile: row.profile })

    return { action: 'create', storedId: created.session_id }
  }

  if (action.kind === 'retry') {
    return { action: 'retry', error: 'the gateway did not answer', storedId: action.storedId || undefined }
  }

  if (action.kind === 'adopt') {
    await pinChat(row, action.storedId)
  }

  // `resume-tip` opens the LIVE tip while the durable pin stays the root: the
  // pin is a stored id and aliasing is core's job (rule 17).
  const opened = await host.openSession(action.storedId, { profile: row.profile })

  if (opened.ok) {
    return { action: action.kind, storedId: action.storedId }
  }

  // The user moved on mid-open. Nothing is wrong and nothing is said.
  if (opened.error === 'superseded') {
    return { action: action.kind, error: opened.error, storedId: action.storedId }
  }

  // We now know something the ladder did not: the pin did not hydrate. Feed
  // that back through the SAME pure function rather than hardcoding the
  // consequence here — rung 2 turns it into `retry`, never `create`, which is
  // what stops a gateway hiccup forking the bot's forever-chat. Until now the
  // flag had no producer at all, so the rung was unreachable.
  const afterFailure = resolveCanonicalChat({ ...ladder, pinHydrationFailed: true })

  return { action: afterFailure.kind, error: opened.error, storedId: action.storedId }
}

/** Persist a bot's chat pin, and report honestly when the gateway refused. */
export async function pinChat(row: RosterRow, storedId: string): Promise<void> {
  await saveBotMeta(row, { ...row.meta, chat: storedId })
}

/** What `saveBotMeta` did. `unsafe` is local — the write never left. */
export type SaveBotMetaOutcome = BotMetaWriteOutcome | 'unsafe'

/**
 * Write one bot's record.
 *
 * Three WIRE outcomes and they are DIFFERENT (§11.1): persisted; refused because
 * the record is over the backend's 64 KB cap; or not reported at all by a gateway
 * too old to answer per-section. Desktop collapsed the last two and told users
 * their settings had failed when the gateway simply could not say.
 *
 * Plus one outcome that never reaches the wire. `profiles.configure` merges
 * `ui_meta` KEY-WISE, so writing `{chat, v}` REPLACES the whole `hermes-bots`
 * value — the bot's title, its `hidden` flag and every room it belongs to go
 * with it. That is correct when `meta` was derived from the record we read, and
 * it is a silent delete when the row never had one. A row from a names-only
 * source (`host.agents()`) carries `meta: {}` that is indistinguishable from a
 * bot with genuinely no record, so the only safe rule is to refuse the write
 * rather than guess which it is.
 */
export async function saveBotMeta(row: RosterRow, meta: BotMeta): Promise<SaveBotMetaOutcome> {
  if (!row.metaKnown) {
    // Refused locally, and SAID so: a verb that silently does nothing is the
    // other half of the bug this guard exists for.
    host.notifyError(
      new Error(`no record was read for ${row.profile}`),
      `${row.name}'s settings cannot be changed from here`
    )

    return 'unsafe'
  }

  const outcome = classifyWrite(await writeBotMeta(row.profile, { ...meta, v: 1 }, routeFor(row)))

  if (outcome === 'persisted') {
    $roster.set($roster.get().map(existing => (existing.key === row.key ? { ...existing, meta } : existing)))
  } else if (outcome === 'rejected') {
    // Rolled back to the server's value rather than retried: retrying an
    // over-cap write forever is how a client burns a gateway.
    host.notifyError(new Error('over the 64 KB limit'), `${row.name}'s settings are full — remove a room to make space`)
  }

  return outcome
}

// ── the hidden-session sweep ────────────────────────────────────────────────

/**
 * Re-assert `hidden` on every session THIS PLUGIN OWNS.
 *
 * Two guards, because `session.set_hidden` flips a session's whole compression
 * lineage — a wrong call buries a real conversation and every ancestor of it:
 *
 *  1. the id must be one we minted (a `chat` pin, or a room member session);
 *  2. the row's TITLE must be one we mint.
 *
 * A stale pin pointing at an ordinary session fails (2), and the repair is to
 * fix the pin, never to hide someone's chat.
 *
 * Idempotent, `allSettled`, one pass — a failure for one id never aborts the
 * sweep.
 */
export async function sweepHiddenSessions(): Promise<{ failed: number; hidden: number; skipped: number }> {
  const roster = $roster.get()
  const rooms = $rooms.get()

  const owned: { id: string; route: AgentRoute; title: string }[] = []

  for (const row of roster) {
    if (row.meta.chat) {
      owned.push({ id: row.meta.chat, route: routeFor(row), title: BOT_CHAT_TITLE })
    }
  }

  for (const room of rooms) {
    for (const [memberKey, sessionId] of Object.entries(room.sessions)) {
      const member = roster.find(candidate => candidate.key === memberKey)

      if (sessionId && member) {
        owned.push({ id: sessionId, route: routeFor(member), title: groupSessionTitle(room.name) })
      }
    }
  }

  let skipped = 0

  // `allSettled`, so one failure never aborts the sweep — but a REJECTION is
  // neither hidden nor skipped, and counting fulfilled-minus-skipped reported
  // it as hidden. A stale pin makes `session.set_hidden` return 4001, so this
  // was the common case, not the edge one.
  const results = await Promise.allSettled(
    owned.map(async entry => {
      // Guard 2 uses the title WE recorded for the id, not one we ask the
      // gateway for: asking would cost a call per session and would still be
      // the same claim.
      if (!maySweep({ owned: true, title: entry.title }) || !isOwnedSessionTitle(entry.title)) {
        skipped += 1

        return
      }

      await setSessionHidden(entry.id, true, entry.route)
    })
  )

  const fulfilled = results.filter(result => result.status === 'fulfilled').length

  return { failed: results.length - fulfilled, hidden: fulfilled - skipped, skipped }
}

/** A bot's @tag, for the composer completions and the room roster. */
export const handleOf = (row: RosterRow): string => row.handle || botHandle(row.profile)
