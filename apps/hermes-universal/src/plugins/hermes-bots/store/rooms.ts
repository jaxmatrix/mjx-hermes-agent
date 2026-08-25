/**
 * Rooms — the EFFECTS half: minting, replicating, deriving and driving.
 *
 * The record is REPLICATED to every member's `ui_meta`. Writes go out with
 * `allSettled` semantics on purpose: a partial write leaves a HIGHER-rev record
 * on some members, and the next merge resolves in favour of the new state, so a
 * half-applied rename is self-healing rather than corrupt. The user is still
 * told which members did not take it.
 */

import { confirm, holdKeepAwake, host } from '@hermes/plugin-sdk'

import { type DriveMember, type RoomDriveDeps, runRoomDrive } from '../driver/rounds'
import { GROUP_LOG_FETCH_LIMIT, type PauseReason } from '../driver/types'
import { botHandle, groupMemberKey, groupSessionTitle, MAIN_THREAD, newRoomId } from '../ids'
import { resolveResponders } from '../model/mentions'
import type { BotMeta, RoomMemberRef, RoomMembership } from '../model/meta'
import { buildTurnPrompt, buildUserTurnPrompt } from '../model/prompt'
import {
  bumpRoom,
  disbandTombstone,
  membershipFor,
  type Room,
  roomSizeRefusal,
  withRoom
} from '../model/rooms'
import type { RosterRow } from '../model/roster'
import {
  buildRoomLog,
  type MemberTranscript,
  type RoomLog,
  watermarkFromMemberSession
} from '../model/transcript'

import {
  $rooms,
  $roster,
  bumpEpoch,
  patchRoomRuntime,
  pushActivity,
  readStranded,
  readWatermark,
  roomRuntime,
  setRoomLog,
  setStranded,
  setWatermark
} from './atoms'
import { refreshRoster, saveBotMeta } from './bots'
import { type AgentRoute, createSession, readTranscript, submitPrompt } from './rpc'

/** ms epoch of the last LOCAL write per room — the `fetchedAt` fence's other
 *  half (§8.2). A roster snapshot older than this cannot overlay it back. */
const writtenAt: Record<string, number> = {}

export const roomWrittenAt = (): Readonly<Record<string, number>> => writtenAt

const rowFor = (memberKey: string): RosterRow | undefined => $roster.get().find(row => row.key === memberKey)

const routeOf = (row: RosterRow): AgentRoute => ({
  ...(row.connectionId ? { connectionId: row.connectionId } : {}),
  profile: row.profile
})

/**
 * Write one room record to EVERY member, serially per profile.
 *
 * Serial per profile because `ui_meta` is a read-modify-write and two rapid
 * edits interleaving on one profile would lose one of them; parallel ACROSS
 * profiles because they are independent documents.
 */
async function replicate(room: Room, membership: RoomMembership): Promise<string[]> {
  writtenAt[room.id] = Date.now()

  const failed: string[] = []

  await Promise.allSettled(
    Object.keys(room.sessions).map(async memberKey => {
      const row = rowFor(memberKey)

      if (!row) {
        failed.push(memberKey)

        return
      }

      const next: BotMeta = withRoom(row.meta, { ...membership, session: room.sessions[memberKey] ?? null })
      const outcome = await saveBotMeta(row, next)

      if (outcome === 'rejected') {
        failed.push(row.name)
      }
    })
  )

  if (failed.length > 0) {
    host.notifyError(new Error(failed.join(', ')), 'Some agents did not accept the room change')
  }

  return failed
}

/**
 * Create a room: mint the id, mint each member's `Group:` session, replicate.
 *
 * The size refusal is checked FIRST and stated plainly. A room whose sixth
 * remote member silently loses its socket lease mid-drive is exactly the
 * failure a user cannot diagnose.
 */
export async function createRoom(name: string, members: readonly RosterRow[]): Promise<null | Room> {
  const refs: RoomMemberRef[] = members.map(row => ({
    ...(row.connectionId ? { connectionId: row.connectionId } : {}),
    handle: botHandle(row.profile),
    profile: row.profile
  }))

  const refusal = roomSizeRefusal(refs)

  if (refusal) {
    host.notifyError(
      new Error(`limit ${refusal.limit}`),
      refusal.reason === 'members'
        ? `A room holds at most ${refusal.limit} agents`
        : `At most ${refusal.limit} agents in a room may live on other machines`
    )

    return null
  }

  const id = newRoomId()
  const at = Date.now()
  const sessions: Record<string, null | string> = {}

  for (const row of members) {
    const created = await createSession({ title: groupSessionTitle(name) }, routeOf(row))

    sessions[row.key] = created.session_id ?? null
  }

  const room: Room = { at, id, members: refs, name, rev: 1, sessions }

  await replicate(room, membershipFor(room, ''))
  $rooms.set([...$rooms.get(), room])

  return room
}

export async function renameRoom(room: Room, name: string): Promise<void> {
  const next = { ...room, ...bumpRoom(membershipFor(room, ''), { name }, Date.now()) }

  await replicate(next, membershipFor(next, ''))
  $rooms.set($rooms.get().map(existing => (existing.id === room.id ? next : existing)))
}

/**
 * Disband: a TOMBSTONE on every member, never a deletion.
 *
 * The epoch is bumped FIRST so an in-flight drive bails at its next check
 * rather than posting into a room that no longer exists.
 */
export async function disbandRoom(room: Room): Promise<boolean> {
  const answer = await confirm({
    confirmLabel: 'Disband',
    description: `"${room.name}" and its threads will disappear from every machine. The agents keep their own transcripts.`,
    destructive: true,
    title: 'Disband this room?'
  })

  if (answer !== true) {
    return false
  }

  bumpEpoch(room.id)

  const tomb = disbandTombstone(membershipFor(room, ''), Date.now())

  await replicate({ ...room, ...tomb }, tomb)
  $rooms.set($rooms.get().filter(existing => existing.id !== room.id))

  return true
}

// ── the derived transcript ──────────────────────────────────────────────────

const memberRows = (room: Room): { row: RosterRow; storedId: string }[] =>
  Object.entries(room.sessions).flatMap(([memberKey, storedId]) => {
    const row = rowFor(memberKey)

    return row && storedId ? [{ row, storedId }] : []
  })

/**
 * Rebuild a room's log from its members' own sessions.
 *
 * Parallel across members and bounded at `GROUP_LOG_FETCH_LIMIT` each — a cold
 * open is six reads, not a scan.
 */
export async function rebuildRoomLog(room: Room): Promise<RoomLog> {
  const members = memberRows(room)

  const transcripts = await Promise.all(
    members.map(async ({ row, storedId }): Promise<MemberTranscript> => {
      const messages = await readTranscript(storedId, routeOf(row))

      return {
        ...(row.connectionId ? { connectionId: row.connectionId } : {}),
        messages: messages.slice(-GROUP_LOG_FETCH_LIMIT),
        profile: row.profile,
        storedId
      }
    })
  )

  const log = buildRoomLog(room.id, transcripts, Date.now())

  setRoomLog(room.id, log)

  // The watermark CACHE is refreshed from the authority on every rebuild, which
  // is what makes a storage wipe re-deliver nothing.
  for (const transcript of transcripts) {
    const memberKey = groupMemberKey(transcript.profile, transcript.connectionId)

    for (const thread of new Set(log.lines.map(line => line.thread))) {
      setWatermark(room.id, thread, memberKey, watermarkFromMemberSession(transcript.messages, thread))
    }
  }

  return log
}

// ── sending, and driving ────────────────────────────────────────────────────

const driveControllers = new Map<string, AbortController>()

/**
 * Files the user attached to the NEXT room send, per room.
 *
 * Held here rather than in the composer's React state because the DRIVE is what
 * stages them, one member at a time, and the drive outlives the pane.
 */
const pendingRefs = new Map<string, { dataUrl: string; name: string }[]>()

export const setRoomAttachments = (roomId: string, files: { dataUrl: string; name: string }[]): void =>
  void (files.length ? pendingRefs.set(roomId, files) : pendingRefs.delete(roomId))

export const roomAttachments = (roomId: string): { dataUrl: string; name: string }[] => pendingRefs.get(roomId) ?? []

/** Is a drive in flight for this room? */
export const roomIsDriving = (roomId: string): boolean => driveControllers.has(roomId)

/**
 * The user sends into a room.
 *
 * The epoch is bumped SYNCHRONOUSLY, before any await, so an in-flight drive
 * sees the supersede at its very next check rather than racing this one.
 */
export async function sendToRoom(room: Room, text: string, thread = MAIN_THREAD): Promise<void> {
  const epoch = bumpEpoch(room.id)
  const at = Date.now()

  driveControllers.get(room.id)?.abort()

  const prompt = buildUserTurnPrompt({ at, roomId: room.id, text, thread })

  // Delivered only to the members the message addresses — which is what makes
  // the log a union of what was actually said rather than a broadcast.
  const log = await rebuildRoomLog(room)
  const addressed = addressedMembers(room, text)

  const files = roomAttachments(room.id)

  await Promise.allSettled(
    addressed.map(async ({ row, storedId }) => {
      const bound = await host.bindSession(storedId, { profile: row.profile })

      if (!bound.ok) {
        return
      }

      // Staged per member, into the member's OWN session, before the prompt
      // that references them goes out.
      const staged = (
        await Promise.all(
          files.map(file =>
            host.attachToSession(storedId, { dataUrl: file.dataUrl, name: file.name, profile: row.profile })
          )
        )
      ).filter((ref): ref is { name: string; ref: string } => ref !== null)

      const withRefs = staged.length ? `${prompt}\n\n${staged.map(ref => ref.ref).join(' ')}` : prompt

      await submitPrompt(bound.sessionKey, withRefs, routeOf(row))
      setWatermark(room.id, thread, row.key, at)
    })
  )

  setRoomAttachments(room.id, [])

  void log

  await driveRoom(room, thread, epoch)
}

function addressedMembers(room: Room, text: string): { row: RosterRow; storedId: string }[] {
  const rows = memberRows(room)
  const speakers = rows.map(({ row }) => ({ connectionId: row.connectionId, handle: row.handle, profile: row.profile }))

  const wanted = new Set(
    resolveAddressed(text, speakers).map(speaker => groupMemberKey(speaker.profile, speaker.connectionId))
  )

  return rows.filter(({ row }) => wanted.has(row.key))
}

/** Thin wrapper so the pure router stays the only place mentions are parsed. */
function resolveAddressed(
  text: string,
  speakers: { connectionId?: string; handle?: string; profile: string }[]
): { connectionId?: string; handle?: string; profile: string }[] {
  // A user line is `from: { kind: 'user' }`, so `resolveResponders` never
  // excludes anyone as "themselves".
  return resolveResponders({ at: 0, from: { kind: 'user' }, seq: 0, text, thread: MAIN_THREAD }, speakers)
}

/** Build the injected effects the rounds engine runs on. */
export function driveDeps(room: Room, thread: string): RoomDriveDeps {
  const rows = memberRows(room)

  const members: DriveMember[] = rows.map(({ row, storedId }) => ({
    ...(row.connectionId ? { connectionId: row.connectionId } : {}),
    handle: row.handle,
    profile: row.profile,
    storedSessionId: storedId
  }))

  const keyOf = (member: DriveMember) => groupMemberKey(member.profile, member.connectionId)
  const rowOf = (member: DriveMember) => rowFor(keyOf(member))

  return {
    awaitResume: async () => undefined,
    buildPrompt: (member, delta, at) =>
      buildTurnPrompt({
        at,
        delta,
        members,
        roomId: room.id,
        roomName: room.name,
        thread,
        viewer: member
      }),
    epoch: () => roomRuntime(room.id).epoch,
    harvest: async member => {
      const row = rowOf(member)

      if (!row) {
        return null
      }

      await rebuildRoomLog(room)

      return null
    },
    // The GATEWAY's view, including sessions this client has no slice for —
    // "is this member still running" is what stops a second prompt.submit
    // landing on a turn already in flight.
    isWorking: member => host.state.liveSessions.get()[member.storedSessionId] === 'working',
    keepAwake: reason => holdKeepAwake(reason),
    members,
    now: () => Date.now(),
    paused: () => roomRuntime(room.id).paused,
    readLog: () => rebuildRoomLog(room),
    report: event => {
      if (event.kind === 'turn') {
        patchRoomRuntime(room.id, { turn: event.member })
      }

      if (event.kind === 'harvested') {
        pushActivity({ at: Date.now(), roomId: room.id, text: `${event.member}: ${event.text}` })
      }
    },
    roomId: room.id,
    roomName: room.name,
    // Mention-scoped: an attachment reaches only the members the message
    // addressed. `host.attachToSession` targets the session it is GIVEN — the
    // composer's own stagers resolve the active session, which would have put
    // all six copies in the user's own chat.
    stageRefs: async member => {
      const row = rowOf(member)
      const pending = pendingRefs.get(room.id)

      if (!row || !pending?.length) {
        return []
      }

      const staged = await Promise.all(
        pending.map(file =>
          host.attachToSession(member.storedSessionId, {
            dataUrl: file.dataUrl,
            name: file.name,
            profile: row.profile
          })
        )
      )

      return staged.filter((ref): ref is { name: string; ref: string } => ref !== null)
    },
    stranded: {
      clear: member => setStranded(room.id, keyOf(member), null),
      get: member => readStranded(room.id, keyOf(member)),
      set: (member, marker) => setStranded(room.id, keyOf(member), marker)
    },
    watermark: async (member, forThread) => readWatermark(room.id, forThread, keyOf(member))
  }
}

/** Run one drive, at most one per room. */
export async function driveRoom(room: Room, thread: string, epoch: number): Promise<void> {
  if (driveControllers.has(room.id)) {
    return
  }

  const controller = new AbortController()

  driveControllers.set(room.id, controller)
  patchRoomRuntime(room.id, { error: null, running: true, thread })

  try {
    const result = await runRoomDrive(driveDeps(room, thread), thread, epoch, controller.signal)

    patchRoomRuntime(room.id, {
      paused: result.status === 'paused' ? (result.reason ?? null) : null,
      running: false,
      turn: null
    })
  } catch (error) {
    patchRoomRuntime(room.id, {
      error: error instanceof Error ? error.message : String(error),
      running: false,
      turn: null
    })
  } finally {
    driveControllers.delete(room.id)
    await rebuildRoomLog(room)
  }
}

/** Pause every open room — the app went to the background, or the gateway
 *  closed. The in-flight member turn is NOT cancelled: the gateway is still
 *  running it and cancelling would throw away work the user is waiting for. */
export function pauseRooms(reason: PauseReason): void {
  for (const room of $rooms.get()) {
    patchRoomRuntime(room.id, { paused: reason })
  }
}

/** Resume: harvest what landed while we were away, then carry on. */
export async function resumeRooms(): Promise<void> {
  for (const room of $rooms.get()) {
    const runtime = roomRuntime(room.id)

    patchRoomRuntime(room.id, { paused: null })

    if (runtime.paused) {
      await rebuildRoomLog(room)
      await driveRoom(room, runtime.thread, runtime.epoch)
    }
  }

  await refreshRoster()
}
