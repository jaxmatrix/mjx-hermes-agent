/**
 * The roster, the canonical Bot Chat, and the hidden-session sweep — the
 * EFFECTS half. Every decision they execute is a pure function in `model/`.
 */

import { host, livePollIntervalMs } from '@hermes/plugin-sdk'

import { BOT_CHAT_TITLE, botHandle, groupSessionTitle, isOwnedSessionTitle } from '../ids'
import { maySweep, type RegistryAnswer, resolveCanonicalChat } from '../model/canonical'
import { type BotMeta, type BotMetaWriteOutcome, classifyWrite } from '../model/meta'
import { liveRooms, roomsFromRoster, rosterMetaSource } from '../model/rooms'
import { handleIndex, mergeMultiSourceRoster, type RosterRow, type RosterRowInput, sortRoster } from '../model/roster'

import { $botProtocolSupported, $rooms, $roster, $rosterError, $rosterLoading } from './atoms'
import {
  type AgentRoute,
  createSession,
  findSessionByTitle,
  listProfiles,
  setSessionHidden,
  setSessionTitle,
  writeBotMeta
} from './rpc'

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
      const local = await listProfiles()

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
  /** `remote` and `unavailable` are not outcomes of the registry lookup —
   *  one refuses before it, the other is the lookup declining to answer. */
  action: 'create' | 'open' | 'remote' | 'unavailable'
  storedId?: string
  error?: string
}

/** The canonical chats this session has opened. Half the basis for the
 *  `/new` rewrite — exact, but it does not survive a reload, which is why the
 *  roster's registry answer is OR-ed with it. */
const openedCanonical = new Set<string>()

export const openedCanonicalIds = (): ReadonlySet<string> => openedCanonical

/**
 * Every session this window believes is a bot's canonical chat.
 *
 * Two independent sources, deliberately: the ids we opened here are exact but
 * do not survive a reload, and the registry ids the roster carries survive one
 * but are only as fresh as the last poll. Neither costs an RPC to read, which
 * matters because the caller is a keystroke path.
 */
export function knownCanonicalIds(): ReadonlySet<string> {
  const ids = new Set(openedCanonical)

  for (const row of $roster.get()) {
    if (row.canonicalId) {
      ids.add(row.canonicalId)
    }
  }

  return ids
}

/** One resolve in flight per profile. All three call sites are fire-and-forget
 *  `void openBotChat(row)`, so a double tap would otherwise run two `create`
 *  rungs concurrently — and the second would mint over the first. */
const opensInFlight = new Map<string, Promise<OpenChatResult>>()

/**
 * Open a bot's private chat.
 *
 * The registry is re-resolved on EVERY open. That is not a cost to apologise
 * for: an exact-title `session.list` is one seek against the unique title
 * index, and it is what removes the need for anything durable to be kept in
 * sync between clients, machines and the database.
 */
export async function openBotChat(row: RosterRow): Promise<OpenChatResult> {
  const inFlight = opensInFlight.get(row.profile)

  if (inFlight) {
    return inFlight
  }

  const run = (async () => {
    const result = await resolveBotChat(row)

    // Reported HERE because all three call sites — the row tap, the kebab verb
    // and the `hermes://bot/…` deep link — used to drop this on the floor, and
    // a failure the user cannot see is one they retry by clicking again.
    if (result.error && result.error !== 'superseded') {
      host.notifyError(
        new Error(result.error),
        result.action === 'unavailable'
          ? `Could not reach ${row.name}'s chat — try again`
          : `Could not open ${row.name}'s chat`
      )
    }

    return result
  })().finally(() => opensInFlight.delete(row.profile))

  opensInFlight.set(row.profile, run)

  return run
}

/** Ask the registry: is there a session with exactly this title here? */
async function askRegistry(route: AgentRoute, title: string = BOT_CHAT_TITLE): Promise<RegistryAnswer> {
  try {
    const found = (await findSessionByTitle(title, route)).sessions?.[0]

    return {
      row: found
        ? { id: found.id, messageCount: found.message_count, resolvedId: found.resolved_id, title: found.title }
        : null
    }
  } catch {
    return { failed: true }
  }
}

async function resolveBotChat(row: RosterRow): Promise<OpenChatResult> {
  // A bot on ANOTHER machine cannot have its chat opened here. Every session
  // door the SDK has — `host.openSession`, `host.bindSession` — takes a PROFILE
  // and no connection, so a remote session id is resumed against THIS gateway,
  // which does not have it. Worse, `openSession` first switches the ACTIVE
  // profile to the foreign name, repointing every profile-scoped call in the
  // app at a profile this backend does not have.
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
  const verdict = resolveCanonicalChat(await askRegistry(route))

  if (verdict.kind === 'unavailable') {
    return { action: 'unavailable', error: 'the gateway did not answer' }
  }

  if (verdict.kind === 'open') {
    return openCanonical(row, verdict.storedId, verdict.expectHistory)
  }

  return createCanonical(row, route)
}

/**
 * Mint the one chat this bot does not have yet.
 *
 * `session.create` persists NOTHING — the row is created lazily on the first
 * prompt, because every launch and every draft opens a session just to paint a
 * composer. A Bot Mode chat has no first prompt to wait for, so the eager
 * `session.title` write is what turns it into a row, and the same call applies
 * the `hidden` flag the create was holding.
 *
 * No kickoff message. Universal has no New-Agent flow, and upstream's rule is
 * that only that flow may introduce a bot — firing an intro from the click path
 * burns a model turn and stamps a user-attributed greeting into the chat every
 * time a lookup misses.
 */
async function createCanonical(row: RosterRow, route: AgentRoute): Promise<OpenChatResult> {
  const created = await createSession({ title: BOT_CHAT_TITLE }, route)
  const runtimeId = created.session_id
  const storedId = created.stored_session_id

  if (!runtimeId || !storedId) {
    return { action: 'create', error: 'session.create did not report both ids' }
  }

  try {
    await setSessionTitle(runtimeId, BOT_CHAT_TITLE, route)
  } catch (error) {
    if (isTitleConflict(error)) {
      // Another writer took the canonical title between our miss and our write —
      // a second client, a peer DM minting server-side. Adopt the winner. Our own
      // half-made session holds no messages and no title, so nothing can reach it
      // and it is simply abandoned.
      const verdict = resolveCanonicalChat(await askRegistry(route), { mayMint: false })

      return verdict.kind === 'open'
        ? openCanonical(row, verdict.storedId, verdict.expectHistory)
        : { action: 'create', error: 'another client holds this bot’s chat title' }
    }

    // Any OTHER failure — an older gateway, a database that would not take the
    // row — leaves a session that is still perfectly live. Only a conflict means
    // some other chat holds this bot's name; re-asking the registry or minting
    // again on anything else is how a second chat gets born. So it is adopted
    // below all the same, and its row persists on the first prompt, exactly as an
    // ordinary new chat's does.
  }

  // ADOPTED, not resumed. The session is live on the gateway under `runtimeId`
  // right now, so there is nothing to wake. Resuming it instead sent a hidden,
  // profile-owned chat through machinery built for sidebar sessions: the owner
  // could not be resolved, the resume missed, and the slice was left bound to a
  // stored id posing as a runtime id — so the first keystroke came back
  // `session not found`, or the open ran out its clock as `exhausted`.
  //
  // The same holds when the title write only queued (`{pending: true}`): adoption
  // needs no row.
  // HIDDEN: a bot's forever-chat is never remembered as the place to land, so a
  // restart can never put it in the main pane as an ordinary chat.
  const opened = await host.openCreatedSession({
    hidden: true,
    profile: row.profile,
    runtimeSessionId: runtimeId,
    storedSessionId: storedId
  })

  if (!opened.ok) {
    return { action: 'create', error: opened.error, storedId }
  }

  openedCanonical.add(storedId)

  return { action: 'create', storedId }
}

/**
 * Was a title write refused because the title is already held?
 *
 * The gateway raises 4022 from the unique title index. The code is read when the
 * transport carries it and the message otherwise — the one signal that means
 * "some other chat is this bot's chat", as opposed to "the write did not land".
 */
function isTitleConflict(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === 4022) {
    return true
  }

  return /already in use/i.test(error instanceof Error ? error.message : String(error ?? ''))
}

async function openCanonical(
  row: RosterRow,
  storedId: string,
  expectHistory: boolean,
  action: OpenChatResult['action'] = 'open'
): Promise<OpenChatResult> {
  const opened = await host.openSession(storedId, { expectHistory, hidden: true, profile: row.profile })

  if (opened.ok) {
    openedCanonical.add(storedId)

    return { action, storedId }
  }

  // The user moved on mid-open. Nothing is wrong and nothing is said.
  return { action, error: opened.error, storedId }
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
 *  1. PROVENANCE — the id came from an exact-title registry lookup we issued,
 *     on a profile in our own roster. There is no other door: no listing, no
 *     recency window, and since the pin is gone, no stored pointer that could
 *     have gone stale and drifted onto someone's real conversation.
 *  2. IDENTITY — the title the GATEWAY reported for that row is one we mint.
 *     Checked separately, because an older gateway answers a title query with
 *     an ordinary listing whose first row is real work.
 *
 * The bot half costs nothing: `session.list {title}` already answered while
 * resolving the roster. The room half is one indexed lookup per member.
 *
 * Idempotent, `allSettled`, one pass — a failure for one id never aborts the
 * sweep.
 */
export async function sweepHiddenSessions(): Promise<{ failed: number; hidden: number; skipped: number }> {
  const roster = $roster.get()
  const rooms = $rooms.get()

  const owned: { id: string; route: AgentRoute; title: string }[] = []

  // Ask the registry, per LOCAL bot, what its canonical chat actually is. A
  // bot with no Bot Chat contributes nothing — where a stale pin used to
  // contribute a 4001 on every reconnect.
  const local = roster.filter(row => !row.connectionId)

  const canonical = await Promise.all(
    local.map(async row => ({ answer: await askRegistry(routeFor(row)), row }))
  )

  for (const { answer, row } of canonical) {
    const found = answer.failed ? null : answer.row

    if (found) {
      owned.push({ id: found.id, route: routeFor(row), title: found.title })
    }
  }

  for (const room of rooms) {
    for (const [memberKey, sessionId] of Object.entries(room.sessions)) {
      const member = roster.find(candidate => candidate.key === memberKey)

      if (!sessionId || !member) {
        continue
      }

      // Verify, never assume: the recorded id must still be the row the
      // registry names for this member's `Group:` title. A renamed room's
      // record is stale, and guessing past that is how the sweep would reach
      // for a session it does not own.
      const title = groupSessionTitle(room.name)
      const answer = await askRegistry(routeFor(member), title)
      const found = answer.failed ? null : answer.row

      if (found && found.id === sessionId) {
        owned.push({ id: sessionId, route: routeFor(member), title: found.title })
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
      // Guard 2 reads the title the GATEWAY reported for this row, not one we
      // remembered — that is what closes the old-gateway hole in the sweep and
      // not only in adoption.
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
