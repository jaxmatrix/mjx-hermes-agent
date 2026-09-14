/**
 * THE ROUNDS ENGINE — one drive per room, strictly serial, epoch-guarded.
 *
 * A module-level actor, not a React effect: every transition here is an awaited
 * promise or a store event, so a re-render cannot restart a drive and unmounting
 * a pane cannot abandon one mid-turn. The room UI observes; it never drives.
 *
 * Strictly serial by design. Six agents answering at once is a thundering herd
 * against a gateway whose per-profile locking the client does not control, and
 * a room where six replies land in a random order is unreadable anyway.
 *
 * Every effect the loop needs is INJECTED (`RoomDriveDeps`). That is what lets
 * the whole engine — caps, rotation, supersede, strand, harvest — run against a
 * fake runner with no gateway, no webview and no clock.
 */

import { resolveResponders, rotateSpeakers } from '../model/mentions'
import type { RoomLine, RoomLog } from '../model/transcript'
import { deltaForMember } from '../model/transcript'

import { currentRunner } from './registry'
import {
  GROUP_CHAT_MAX_MESSAGES,
  GROUP_CHAT_MAX_ROUNDS,
  GROUP_TURN_HARD_CAP_MS,
  GROUP_TURN_TIMEOUT_MS,
  type PauseReason,
  type RoomTurnMember,
  type RoomTurnOutcome
} from './types'

export interface DriveMember extends RoomTurnMember {
  handle?: string
}

/** A member whose turn timed out. Persisted, so a late reply survives a reload. */
export interface StrandedMarker {
  before: number
  thread: string
  at: number
}

export interface RoomDriveDeps {
  roomId: string
  roomName: string
  members: readonly DriveMember[]
  now(): number
  /** The room's epoch. A user send bumps it BEFORE any await. */
  epoch(): number
  /** Non-null while the drive must not proceed. */
  paused(): null | PauseReason
  /** Resolves when `paused()` goes null again, or rejects to abandon. */
  awaitResume(): Promise<void>
  /** The gateway's own view — including sessions this client has no slice for. */
  isWorking(member: DriveMember): boolean
  /** The room log, refreshed from the member sessions. */
  readLog(): Promise<RoomLog>
  /** How far this member has been told, from ITS OWN session. */
  watermark(member: DriveMember, thread: string): Promise<number>
  /** Stage the delta's attachments into this member's session. */
  stageRefs(member: DriveMember, lines: readonly RoomLine[]): Promise<{ name: string; ref: string }[]>
  /** Build the prompt for one member's turn. */
  buildPrompt(member: DriveMember, delta: readonly RoomLine[], at: number): string
  stranded: {
    get(member: DriveMember): StrandedMarker | undefined
    set(member: DriveMember, marker: StrandedMarker): void
    clear(member: DriveMember): void
  }
  /** Read a member's transcript once, to collect a late reply. */
  harvest(member: DriveMember, marker: StrandedMarker): Promise<null | string>
  /** Hold the machine awake for the drive. Desktop-only; a no-op elsewhere. */
  keepAwake(reason: string): () => void
  /** Progress, for the activity feed and the member cards. */
  report(event: DriveEvent): void
}

export type DriveEvent =
  | { kind: 'harvested'; member: string; text: string }
  | { kind: 'outcome'; member: string; outcome: RoomTurnOutcome }
  | { kind: 'round'; round: number; speakers: string[] }
  | { kind: 'turn'; member: string }

export type DriveStatus = 'error' | 'exhausted' | 'paused' | 'settled' | 'superseded'

export interface DriveResult {
  status: DriveStatus
  /** How many member messages this drive posted. */
  posted: number
  reason?: PauseReason
}

/**
 * Deliver every late reply BEFORE this drive plans anything.
 *
 * A stranded member's reply is part of the conversation the next round reasons
 * about. Harvesting after planning would mean the round was planned against a
 * log that was already stale.
 *
 * Three outcomes, and they are different: a real reply is posted and the marker
 * cleared; a late `(pass)` clears the marker WITHOUT posting; a member still
 * running consumes nothing and is excluded from this round — resubmitting into
 * it is the one thing that must never happen.
 */
export async function harvestStranded(deps: RoomDriveDeps): Promise<Set<string>> {
  const stillRunning = new Set<string>()

  for (const member of deps.members) {
    const marker = deps.stranded.get(member)

    if (!marker) {
      continue
    }

    if (deps.isWorking(member)) {
      stillRunning.add(member.profile)

      continue
    }

    const text = await deps.harvest(member, marker)

    // Cleared either way: the member has stopped running, so whatever it was
    // going to say it has now said. `null` covers a late `(pass)` and a member
    // that produced nothing at all.
    deps.stranded.clear(member)

    if (text) {
      deps.report({ kind: 'harvested', member: member.profile, text })
    }
  }

  return stillRunning
}

/** Who speaks this round: everyone the newest lines address, rotated. */
export function plannedSpeakers(
  log: RoomLog,
  thread: string,
  members: readonly DriveMember[],
  round: number
): DriveMember[] {
  const lines = log.lines.filter(line => line.thread === thread)
  const last = lines[lines.length - 1]

  if (!last) {
    return []
  }

  const addressed = resolveResponders(last, members)

  return rotateSpeakers(
    members.filter(member => addressed.some(speaker => speaker.profile === member.profile)),
    round
  )
}

/**
 * Run one member's turn.
 *
 * The liveness guard is checked HERE rather than only at planning time: a
 * member can start running between the plan and its turn (another room, a cron
 * job, a second client), and a second `prompt.submit` into a running session is
 * how two half-answers interleave into one unreadable reply.
 */
export async function runMemberTurn(
  deps: RoomDriveDeps,
  member: DriveMember,
  thread: string,
  log: RoomLog,
  epochAtStart: number,
  signal: AbortSignal
): Promise<RoomTurnOutcome> {
  if (deps.isWorking(member)) {
    deps.stranded.set(member, { at: deps.now(), before: 0, thread })

    return { status: 'busy' }
  }

  const watermark = await deps.watermark(member, thread)
  const delta = deltaForMember(log, thread, watermark, member.profile)

  if (delta.length === 0) {
    return { status: 'pass' }
  }

  if (deps.epoch() !== epochAtStart) {
    return { status: 'superseded' }
  }

  const at = deps.now()
  const refs = await deps.stageRefs(member, delta)

  const outcome = await currentRunner().run(
    {
      epoch: epochAtStart,
      hardCapMs: GROUP_TURN_HARD_CAP_MS,
      member,
      prompt: deps.buildPrompt(member, delta, at),
      refs,
      roomId: deps.roomId,
      threadId: thread,
      timeoutMs: GROUP_TURN_TIMEOUT_MS
    },
    signal
  )

  if (outcome.status === 'timeout') {
    deps.stranded.set(member, { at, before: outcome.strandedBefore, thread })
  }

  return outcome
}

/**
 * Drive a room until it settles, exhausts its caps, or is superseded.
 *
 * `epochAtStart` is captured by the caller BEFORE the first await; every loop
 * iteration re-checks it, which is what makes a second user send abandon the
 * old drive rather than racing it.
 */
export async function runRoomDrive(
  deps: RoomDriveDeps,
  thread: string,
  epochAtStart: number,
  signal: AbortSignal
): Promise<DriveResult> {
  const release = deps.keepAwake(`bot-room:${deps.roomId}`)

  let posted = 0

  try {
    for (let round = 0; round < GROUP_CHAT_MAX_ROUNDS; round++) {
      if (deps.epoch() !== epochAtStart) {
        return { posted, status: 'superseded' }
      }

      const pause = deps.paused()

      if (pause) {
        // The in-flight member turn is NOT cancelled — the gateway is still
        // running it, and cancelling would throw away work the user is waiting
        // for. We stop planning, and say so.
        deps.report({ kind: 'outcome', member: '', outcome: { reason: pause, status: 'paused' } })

        return { posted, reason: pause, status: 'paused' }
      }

      const running = await harvestStranded(deps)
      const log = await deps.readLog()

      const speakers = plannedSpeakers(log, thread, deps.members, round).filter(
        member => !running.has(member.profile)
      )

      deps.report({ kind: 'round', round, speakers: speakers.map(member => member.profile) })

      let spoke = 0

      for (const member of speakers) {
        if (deps.epoch() !== epochAtStart) {
          return { posted, status: 'superseded' }
        }

        if (posted >= GROUP_CHAT_MAX_MESSAGES) {
          return { posted, status: 'exhausted' }
        }

        deps.report({ kind: 'turn', member: member.profile })

        const outcome = await runMemberTurn(deps, member, thread, log, epochAtStart, signal)

        deps.report({ kind: 'outcome', member: member.profile, outcome })

        if (outcome.status === 'superseded') {
          return { posted, status: 'superseded' }
        }

        if (outcome.status === 'paused') {
          return { posted, reason: outcome.reason, status: 'paused' }
        }

        // A failed member turn is a PASS, not a room error. One agent timing out
        // or erroring must not take the conversation down with it — the member
        // card says what happened and the round carries on.
        if (outcome.status === 'reply') {
          posted += 1
          spoke += 1
        }
      }

      if (spoke === 0) {
        return { posted, status: 'settled' }
      }
    }

    return { posted, status: 'exhausted' }
  } finally {
    release()
  }
}
